'use strict';

// Synchronously read all of stdin as a UTF-8 string. Hooks are invoked with
// a JSON blob piped in; we need the whole thing before we can decide what
// to do. Works cross-platform (Linux, macOS, Windows) — Node's fs.readSync
// on fd 0 is portable.

const fs = require('fs');

function readStdinSync() {
  const chunks = [];
  const buf = Buffer.alloc(65536);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      // EAGAIN can happen on some Linux kernels for stdin. Treat as "done"
      // rather than crashing — we've either got what we got, or nothing.
      if (err.code === 'EAGAIN') break;
      // EOF on some platforms is surfaced as a thrown error.
      if (err.code === 'EOF') break;
      throw err;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }

  return Buffer.concat(chunks).toString('utf8');
}

module.exports = { readStdinSync };
