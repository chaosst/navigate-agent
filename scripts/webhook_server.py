#!/usr/bin/env python3
"""
navigate Gitee WebHook 接收端（Python 标准库实现，零依赖、无需下载任何二进制）

用途：Gitee push 时 POST 到 /hooks/deploy，校验 X-Gitee-Token 后执行部署脚本。

用法：
  python3 webhook_server.py --port 9000 --secret <你的密码>
  # 部署日志追加到 /var/log/webhook-deploy.log

关联：/opt/navigate/scripts/deploy.sh（部署脚本）
"""
import argparse
import hmac
import logging
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEPLOY_SCRIPT = "/opt/navigate/scripts/deploy.sh"
LOG_FILE = "/var/log/webhook-deploy.log"


class Handler(BaseHTTPRequestHandler):
    secret = ""
    deploy_script = DEPLOY_SCRIPT

    def log_message(self, fmt, *args):  # 交给 logging，便于统一看日志
        logging.info("%s - %s", self.client_address[0], fmt % args)

    def do_POST(self):
        if self.path != "/hooks/deploy":
            self.send_error(404)
            return

        # ① 校验 Gitee Token，防伪造请求
        token = self.headers.get("X-Gitee-Token", "")
        if not hmac.compare_digest(token, self.secret):
            logging.warning("reject: bad token from %s", self.client_address[0])
            self.send_error(401)
            return

        # ② 只响应 Push 事件（Gitee 还会发 Ping 等探测）
        if self.headers.get("X-Gitee-Event", "") != "Push Hook":
            logging.info("ignore event: %s", self.headers.get("X-Gitee-Event"))
            self.send_error(400, "not a push hook")
            return

        # ③ 后台执行部署脚本，不阻塞 HTTP 响应
        threading.Thread(target=self._run_deploy, daemon=True).start()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"deploy started"}')

    def _run_deploy(self):
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write("\n===== deploy triggered %s =====\n" % time.strftime("%F %T"))
            subprocess.run([self.deploy_script], stdout=f, stderr=subprocess.STDOUT)
            f.write("===== done %s =====\n" % time.strftime("%F %T"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="navigate Gitee WebHook receiver")
    ap.add_argument("--port", type=int, default=9000)
    ap.add_argument("--secret", required=True, help="与 Gitee WebHook 密码一致")
    args = ap.parse_args()
    Handler.secret = args.secret

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    logging.info("webhook listening on :%d, deploy script: %s", args.port, DEPLOY_SCRIPT)
    server.serve_forever()
