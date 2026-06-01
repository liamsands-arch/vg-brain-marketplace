#!/usr/bin/env node
// VG Brain PreCompact hook — capture-insurance snapshot before compaction.
// Mirrors the SessionEnd hook: POSTs the current transcript to /ingest so a
// session that never cleanly closes (crash/sleep/force-quit) still gets
// captured. Dedup + the per-session watermark make the overlap with
// SessionEnd harmless. NEVER blocks compaction; exits 0 on every path.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

function bail(msg) {
  if (msg) process.stderr.write("[vg-brain pre-compact] " + msg + "\n");
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

function readStdin() {
  return new Promise(function (resolve) {
    var data = "";
    var settled = false;
    function finish() { if (!settled) { settled = true; resolve(data); } }
    try { process.stdin.setEncoding("utf8"); } catch (e) {}
    process.stdin.on("data", function (c) { data += c; });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 3000);
  });
}

function post(urlStr, token, bodyObj) {
  return new Promise(function (resolve) {
    var u;
    try { u = new URL(urlStr); } catch (e) { resolve(null); return; }
    var payload = Buffer.from(JSON.stringify(bodyObj), "utf8");
    var lib = u.protocol === "http:" ? httpRequest : httpsRequest;
    var req = lib(u, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
        Authorization: "Bearer " + token
      }
    }, function (res) {
      var data = "";
      res.on("data", function (c) { data += c; });
      res.on("end", function () { resolve({ status: res.statusCode, body: data }); });
    });
    req.on("error", function () { resolve(null); });
    req.setTimeout(15000, function () { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

var endpoint = loadEndpoint();
var token = loadToken();
if (!token) process.exit(0); // no cached OAuth token yet (or expired) — no-op
var base = endpoint.replace(/\/mcp\/?$/, "");

var stdinRaw = await readStdin();
var input = {};
try { input = JSON.parse(stdinRaw); } catch (e) { input = {}; }

var sessionId = input.session_id || input.sessionId || "";
var transcriptPath = input.transcript_path || input.transcriptPath || "";
if (!sessionId || !transcriptPath) bail("missing session_id or transcript_path");

var transcript = "";
try {
  transcript = readFileSync(transcriptPath, "utf8");
} catch (e) {
  bail("cannot read transcript: " + (e && e.message));
}
if (!transcript) process.exit(0);

var body = {
  session_id: sessionId,
  transcript: transcript,
  reason: "pre-compact",
  source: "cowork-precompact-hook",
  meta: {
    cwd: input.cwd || null,
    transcript_path: transcriptPath,
    hook_event_name: input.hook_event_name || "PreCompact",
    trigger: input.trigger || null
  }
};

await post(base + "/ingest", token, body);
process.exit(0);
