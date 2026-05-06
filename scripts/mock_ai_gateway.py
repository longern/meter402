#!/usr/bin/env python3
"""Mock AI Gateway for Meteria402 closed-loop testing."""
import json
from http.server import HTTPServer, BaseHTTPRequestHandler

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_len = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_len)
        
        response = {
            "id": "mock-chat-completion",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "test-model",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Hello from mock AI Gateway"},
                    "finish_reason": "stop"
                }
            ],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 20,
                "total_tokens": 30
            }
        }
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('cf-aig-log-id', 'mock-log-123')
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())

    def log_message(self, format, *args):
        pass  # suppress logs

if __name__ == "__main__":
    httpd = HTTPServer(("127.0.0.1", 8788), Handler)
    print("Mock AI Gateway on http://127.0.0.1:8788")
    httpd.serve_forever()
