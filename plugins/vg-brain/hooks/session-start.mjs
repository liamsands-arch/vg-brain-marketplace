#!/usr/bin/env node
// VG Brain SessionStart hook — fetch the per-user context header and inject it.
// Exits 0 on every path; a header fetch must never block a session opening.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

function bail(msg) {
  if (msg) process.stderr.write("[vg-brain session-start] " + msg + "\n");
  process.exit(0);
}

function loadEndpoint() {
  var root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) bail("CLAUDE_PLUGIN_ROOT unset");
  var raw;
  try {
    raw = readFileSync(root + "/.mcp.json", "utf8");
  } catch (e) {
    bail("cannot read .mcp.json: " + (e && e.message));
  }
  var cfg = JSON.parse(raw);
  var servers = (cfg && cfg.mcpServers) || {};
  var keys = Object.keys(servers);
  for (var i = 0; i < keys.length; i++) {
    var args = (servers[keys[i]] && servers[keys[i]].args) || [];
    for (var j = 0; j < args.length; j++) {
      var a = String(args[j]);
      if (/^https?:\/\/.+\/mcp\/?$/.test(a)) return a;
    }
  }
  bail("no endpoint in .mcp.json");
}

// Secret-less auth: the bundle carries NO bearer token. mcp-remote authenticates
// via OAuth (DCR + browser handshake) and caches the access token at
// ~/.mcp-auth/mcp-remote-<version>/<serverHash>_tokens.json. Read the NEWEST such
// token across ALL version dirs — the version dir tracks mcp-remote's INTERNAL
// version, which does NOT match the npm tag, so glob; never hardcode 0.1.x.
// NOTE: tokens are ~30-day with NO refresh token. Once expired this returns null
// and the hook no-ops until the user re-auths (reconnects the MCP server in
// Cowork) — re-auth is manual. Every failure path returns null so the caller
// can exit 0 cleanly and never error.
function loadToken() {
  try {
    var home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return null;
    var authBase = home + "/.mcp-auth";
    var dirs;
    try { dirs = readdirSync(authBase); } catch (e) { return null; }
    var bestPath = null;
    var bestMtime = -1;
    for (var i = 0; i < dirs.length; i++) {
      if (String(dirs[i]).indexOf("mcp-remote-") !== 0) continue;
      var dir = authBase + "/" + dirs[i];
      var files;
      try { files = readdirSync(dir); } catch (e) { continue; }
      for (var j = 0; j < files.length; j++) {
        if (!/_tokens\.json$/.test(files[j])) continue;
        var p = dir + "/" + files[j];
        try {
          var mt = statSync(p).mtimeMs;
          if (mt > bestMtime) { bestMtime = mt; bestPath = p; }
        } catch (e) {}
      }
    }
    if (!bestPath) return null;
    var parsed = JSON.parse(readFileSync(bestPath, "utf8"));
    if (parsed && typeof parsed.access_token === "string" && parsed.access_token) {
      return parsed.access_token;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function get(urlStr, token) {
  return new Promise(function (resolve) {
    var u;
    try { u = new URL(urlStr); } catch (e) { resolve(null); return; }
    var lib = u.protocol === "http:" ? httpRequest : httpsRequest;
    var req = lib(u, { method: "GET", headers: { Authorization: "Bearer " + token } }, function (res) {
      var data = "";
      res.on("data", function (c) { data += c; });
      res.on("end", function () { resolve({ status: res.statusCode, body: data }); });
    });
    req.on("error", function () { resolve(null); });
    req.setTimeout(8000, function () { req.destroy(); resolve(null); });
    req.end();
  });
}

function readStdin() {
  return new Promise(function (resolve) {
    var data = "";
    var settled = false;
    function finish() { if (!settled) { settled = true; resolve(data); } }
    try { process.stdin.setEncoding("utf8"); } catch (e) {}
    process.stdin.on("data", function (c) { data += c; });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 2000);
  });
}

var endpoint = loadEndpoint();
var token = loadToken();
if (!token) process.exit(0); // no cached OAuth token yet (or expired) — no-op
var base = endpoint.replace(/\/mcp\/?$/, "");

// Read the hook stdin to learn the start SOURCE (startup|resume|clear|compact)
// and session id. Forwarding source lets the server (a) log whether Cowork
// fires a compaction-triggered start, and (b) re-ground: on source=compact it
// injects the session handoff summary instead of the generic startup header.
var stdinRaw = await readStdin();
var input = {};
try { input = JSON.parse(stdinRaw); } catch (e) { input = {}; }
var source = input.source || input.matcher || "";
var sessionId = input.session_id || input.sessionId || "";

var qs = [];
if (source) qs.push("source=" + encodeURIComponent(source));
if (sessionId) qs.push("session_id=" + encodeURIComponent(sessionId));
var path = "/context-header" + (qs.length ? "?" + qs.join("&") : "");

var resp = await get(base + path, token);
if (!resp || resp.status !== 200) process.exit(0);
var header = "";
try { var parsed = JSON.parse(resp.body); header = (parsed && parsed.header) || ""; } catch (e) { process.exit(0); }
if (!header) process.exit(0);
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: header }
}));
process.exit(0);
