// Session-log scanner: find every historical full copy of web/js/main.js.
//
// main.js was destroyed by a bad patch script. pi keeps a JSONL session log with every tool call,
// so the file can be recovered from the newest write that carried its whole content, or rebuilt
// from the newest read chunks. This lists candidates rather than trusting one.
const fs = require('fs');
const path = require('path');

const LOG = process.argv[2];
const TARGET = process.argv[3] || 'web/js/main.js';

let lineNo = 0, found = [];
const buf = let acc = '';
