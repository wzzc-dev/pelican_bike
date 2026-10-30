#!/usr/bin/env python3
"""Measure frame pacing of a packaged MoUI web app in headless Chrome.

Loads a packaged page over the Chrome DevTools Protocol, waits for the app to
report "Running", then samples requestAnimationFrame deltas for a few seconds.
Main-thread cost per frame shows up directly as a reduced rAF rate, so this is a
useful smoke test for "the web build feels laggy" reports.

Requirements: python3, `pip install websocket-client`, Google Chrome.

Usage:
  python3 scripts/measure-web-perf.py http://127.0.0.1:8123/index.html
  python3 scripts/measure-web-perf.py https://example.github.io/app/ --seconds 6
"""

import argparse
import json
import subprocess
import sys
import time
import urllib.request

import websocket

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def measure(url, chrome, port, seconds, interval):
    profile = "/tmp/moui-web-perf-%d" % port
    subprocess.run(["rm", "-rf", profile], check=False)
    proc = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            "--no-sandbox",
            "--remote-debugging-port=%d" % port,
            "--user-data-dir=" + profile,
            "--window-size=1280,800",
            url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        target = None
        for _ in range(80):
            time.sleep(0.5)
            try:
                with urllib.request.urlopen(
                    "http://127.0.0.1:%d/json/list" % port, timeout=2
                ) as response:
                    targets = json.load(response)
            except Exception:
                continue
            for candidate in targets:
                if candidate.get("type") == "page" and url.split("/")[-1] in candidate.get(
                    "url", ""
                ):
                    target = candidate
                    break
            if target:
                break
        if not target:
            raise SystemExit("could not attach to the page target")

        ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=120)
        message_id = [0]

        def send(method, params=None):
            message_id[0] += 1
            ws.send(
                json.dumps({"id": message_id[0], "method": method, "params": params or {}})
            )
            while True:
                message = json.loads(ws.recv())
                if message.get("id") == message_id[0]:
                    return message

        def evaluate(expression):
            result = send(
                "Runtime.evaluate",
                {"expression": expression, "awaitPromise": True, "returnByValue": True},
            )
            return result.get("result", {}).get("result", {}).get("value")

        send("Runtime.enable")
        status = ""
        for _ in range(60):
            time.sleep(0.5)
            status = evaluate("document.querySelector('#status')?.textContent || ''") or ""
            if status in ("Running", "Failed"):
                break
        if status != "Running":
            raise SystemExit("app did not reach Running (status: %r)" % status)

        log = evaluate("document.querySelector('#log')?.textContent || ''") or ""
        markers = ("WebGPU ready", "switching to Canvas2D", "WebGPU initialization failed")
        renderer = next(
            (line for line in reversed(log.splitlines()) if any(m in line for m in markers)),
            "unknown renderer",
        )

        pacing = evaluate(
            "new Promise(resolve => {"
            "  const stamps = [];"
            "  const start = performance.now();"
            "  const tick = t => {"
            "    stamps.push(t);"
            "    if (performance.now() - start < %d) { requestAnimationFrame(tick); return; }"
            "    const deltas = [];"
            "    for (let i = 1; i < stamps.length; i++) deltas.push(stamps[i] - stamps[i - 1]);"
            "    deltas.sort((a, b) => a - b);"
            "    const at = p => deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))] : 0;"
            "    resolve({"
            "      frames: stamps.length,"
            "      fps: stamps.length / Math.max(1, (stamps[stamps.length - 1] - stamps[0]) / 1000),"
            "      median: at(0.5),"
            "      p95: at(0.95)"
            "    });"
            "  };"
            "  requestAnimationFrame(tick);"
            "})" % int(seconds * 1000)
        )
        return {"url": url, "renderer": renderer, "pacing": pacing}
    finally:
        proc.kill()
        proc.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="packaged page URL served over http(s)")
    parser.add_argument("--seconds", type=float, default=4.0)
    parser.add_argument("--port", type=int, default=9333)
    parser.add_argument("--chrome", default=CHROME)
    args = parser.parse_args()

    report = measure(args.url, args.chrome, args.port, args.seconds, args.port)
    print(json.dumps(report, indent=2))
    fps = report["pacing"]["fps"]
    print("\nfps: %.1f (median frame %.1f ms)" % (fps, report["pacing"]["median"]))
    return 0 if fps >= 50 else 1


if __name__ == "__main__":
    sys.exit(main())
