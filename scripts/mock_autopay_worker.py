#!/usr/bin/env python3
"""Mock Autopay Worker for Meteria402 closed-loop testing."""
import json
from http.server import HTTPServer, BaseHTTPRequestHandler

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_len = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(content_len))
        
        if self.path == '/api/auth/requests':
            response = {
                "request_id": "mock-auth-req-123",
                "poll_token": "mock-poll-token-123",
                "verification_uri_complete": "http://localhost:9999/auth/mock-auth-req-123"
            }
            self.send_response(201)
        elif self.path == '/api/pay':
            response = {
                "payment_payload": {
                    "scheme": "exact_evm",
                    "network": "eip155:8453",
                    "payload": {
                        "txHash": "0xmocktxhash"
                    }
                },
                "headers": {"x-payment-signature": "mock-sig"}
            }
            self.send_response(200)
        else:
            self.send_response(404)
            response = {"error": "not found"}
        
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())

    def do_GET(self):
        if '/poll' in self.path:
            response = {
                "status": "approved",
                "authorization": {
                    "owner": "0xMockOwnerAddress",
                    "siwe_message": "localhost wants you to sign in with your Ethereum account:\\n0xMockOwnerAddress\\n\\nAuthorize payment\\n\\nURI: http://localhost:8789\\nVersion: 1\\nChain ID: 8453\\nNonce: mocknonce\\nIssued At: 2026-01-01T00:00:00.000Z\\nExpiration Time: 2030-01-01T00:00:00.000Z",
                    "siwe_signature": "0x0000000000000000000000000000000000000000000000000000000000000000"
                }
            }
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
        else:
            self.send_response(404)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "not found"}).encode())

    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    httpd = HTTPServer(("127.0.0.1", 8789), Handler)
    print("Mock Autopay Worker on http://127.0.0.1:8789")
    httpd.serve_forever()
