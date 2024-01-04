import http from "node:http"
import {Buffer} from "node:buffer"
import path from "node:path"
import fs from "node:fs"
import { pipeline } from "node:stream"
import { createGzip } from "node:zlib"
import mime from "mime"
import rangeParser from "range-parser"

const PORT = 8000;
const PATHNAME_REGEXP = /^\/([A-Za-z0-9_\-~])*(\.[A-Za-z0-9_\-~]+)*$/;
const ROOT_FOLDER = path.resolve("public");
const DEFAULT_INDEX = "index.html";
const CACHE_MAX_AGE = 600;
const DEFAULT_HEADERS = {
  "Accept-Ranges": "bytes",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD",
  "X-Content-Type-Options": "nosniff",
  "Vary": "Accept-Encoding"
}

const server = http.createServer((req, res) => {

  const pathname = req.url.split("?")[0];
  
  for(const header in DEFAULT_HEADERS) {
    res.setHeader(header, DEFAULT_HEADERS[header]);
  }

  // Validate request
  
  if(req.httpVersion !== "1.1") {
    return sendError(req, res, 505, "Only HTTP/1.1 is supported");
  }

  if(req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return sendError(req, res, 405, "Only GET and HEAD methods are allowed");
  }

  if(!PATHNAME_REGEXP.test(pathname)) {
    return sendError(req, res, 400, `Invalid pathname: ${pathname}`);
  }

  // Send file

  fetchFile(pathname)
  .then(({filepath, stat}) => {
    res.setHeader("Content-Type", getMIMEType(filepath));
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", `public, max-age=${CACHE_MAX_AGE}`);
    res.setHeader("Last-Modified", stat.mtime.toUTCString());
    res.setHeader("Etag", getEtag(stat));

    if(req.headers.range) {
      return sendRangeResponse(req, res, filepath, stat);
    }

    if(req.headers["if-modified-since"] || req.headers["if-none-match"]) {
      handleCacheValidation(req, res, filepath, stat);
      return;
    }

    sendFullResponse(req, res, filepath, stat);
  })
  .catch(e => {
    if(e?.code === "ENOENT") {
      sendError(req, res, 404, `Not found: ${pathname}`);
    } else {
      sendError(req, res, 500, e?.message);
    }
  })
})

function sendError(req, res, status = 500, message = "") {
  let body;
  if(!res.headersSent) {
    body = JSON.stringify({
      status,
      statusMessage: http.STATUS_CODES[status],
      message
    })
    removeResHeaders(res, ["Etag", "Last-Modified", "Vary", "Content-Encoding"]);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-cache"
    })
    res.end(body);
  }
}

async function fetchFile(pathname) {
  let filepath = path.join(ROOT_FOLDER, pathname);
  let stat = await fs.promises.stat(filepath);

  if(stat.isDirectory()) {
    filepath = path.join(filepath, DEFAULT_INDEX);
    stat = await fs.promises.stat(filepath);
  }

  await fs.promises.access(filepath, fs.constants.R_OK);
  
  return {filepath, stat};
}

function getMIMEType(filepath) {
  let MIME = mime.getType(filepath) || "application/octet-stream";
  if(MIME.startsWith("text")) {
    MIME += "; charset=utf-8";
  }
  return MIME;
}

function getEtag(stat) {
  const mtime = stat.mtime.getTime().toString(16)
  const size = stat.size.toString(16)
  return `"${size}-${mtime}"`;
}

function removeResHeaders(res, headers = []) {
  headers.forEach(header => {
    res.removeHeader(header);
  })
}

function sendFullResponse(req, res, filepath, stat) {
  const readable = fs.createReadStream(filepath);
  const MIME = res.getHeader("Content-Type");
  const encodings = req.headers["accept-encoding"];

  function handleErr(e) {
    if(e) sendError(req, res, 500, e?.message);
  }

  res.statusCode = 200;

  if(
    encodings &&
    encodings.split(", ").indexOf("gzip") !== -1 &&
    !/^(audio|image|video)/.test(MIME)
  ) {
    res.setHeader("Content-Encoding", "gzip");
    res.removeHeader("Content-Length");
    pipeline(readable, createGzip(), res, handleErr);
  }

  else {
    pipeline(readable, res, handleErr);
  }

}

function handleCacheValidation(req, res, filepath, stat) {
  const serverEtag = res.getHeader("Etag");
  const serverLastModified = Date.parse(res.getHeader("Last-Modified"));
  const clientEtag = req.headers["if-none-match"];
  const clientLastModified = Date.parse(req.headers["if-modified-since"]);

  if(
    (clientEtag && clientEtag === serverEtag) ||
    (clientLastModified !== NaN && clientLastModified >= serverLastModified)
  ) {
    removeResHeaders(res, [
      "Content-Type", "Content-Length", "Content-Encoding", "Content-Range"
    ]);
    res.writeHead(304);
    res.end();
  }

  else {
    sendFullResponse(req, res, filepath, stat);
  }
}

function sendRangeResponse(req, res, filepath, stat) {
  const serverEtag = res.getHeader("Etag");
  const serverLastModified = Date.parse(res.getHeader("Last-Modified"));
  const ifRange = req.headers["if-range"];
  const range = rangeParser(stat.size, req.headers.range);
  let readable;

  if(range === -1 || range === -2 || range.type !== "bytes") {
    return sendError(req, res, 416, `Invalid range ${req.headers.range}`);
  }

  if(ifRange) {
    // if-range header can be an Etag or Last-Modified
    if(
      (Date.parse(ifRange) !== NaN && serverLastModified > Date.parse(ifRange)) ||
      ifRange !== serverEtag
    ) {
      // Ressource modified
      return sendFullResponse(req, res, filepath, stat);
    }
  }

  delete range["type"];
  res.statusCode = 206;

  // Send single part range
  if(range.length === 1) {
    readable = fs.createReadStream(filepath, range[0]);
    res.setHeader("Content-Range", `bytes ${range[0].start}-${range[0].end}/${stat.size}`);
    res.setHeader("Content-Length", range[0].end - range[0].start + 1);
    pipeline(readable, res, e => {
      if(e) sendError(req, res, 500, e?.message);
    });
  }

  else {
    sendMultipartRanges(req, res, filepath, stat, range);
  }
}

function sendMultipartRanges(req, res, filepath, stat, ranges = []) {
  const boundary = new Date().getTime().toString(16);
  const MIME = res.getHeader("Content-Type");
  let readable;

  res.setHeader("Content-Type", `multipart/byteranges; boundary=${boundary}`);
  res.removeHeader("Content-Length");
  next();

  function next(i = 0, error = false) {
    if(error) {
      return sendError(req, res, 500);
    }
    if(i >= ranges.length) {
      res.end(`\n--${boundary}--`);
      return;
    }
    readable = fs.createReadStream(filepath, ranges[i]);
    res.write(`${i === 0 ? '' : '\n'}--${boundary}\n`);
    res.write(`Content-Type: ${MIME}\n`);
    res.write(`Content-Range: bytes ${ranges[i].start}-${ranges[i].end}/${stat.size}\n`);
    readable.on("error", e => {
      next(i, true);
    })
    readable.on("end", () => {
      next(++i);
    })
    readable.pipe(res, {end: false});
  }
}

server.listen(PORT);