#!/usr/bin/env python3
"""
DocStudio Offline Open-Source Conversion Engine
Provides high-fidelity PDF <-> Word (DOCX) conversions using pdf2docx and LibreOffice headless.
Compatible with Python 3.14+ (No deprecated cgi module).
"""

import os
import sys
import tempfile
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
import json

PORT = 5005

def extract_file_from_multipart(body_bytes, boundary):
    """Simple, zero-dependency multipart/form-data parser"""
    boundary_marker = b'--' + boundary.encode()
    parts = body_bytes.split(boundary_marker)
    for part in parts:
        if b'Content-Disposition' in part and b'filename=' in part:
            header_end = part.find(b'\r\n\r\n')
            if header_end != -1:
                file_data = part[header_end + 4:]
                if file_data.endswith(b'\r\n'):
                    file_data = file_data[:-2]
                return file_data
    return None

class ConversionHandler(BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path == '/api/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            status = {
                "status": "online",
                "engine": "OpenSource DocStudio Engine",
                "pdf2docx_available": True,
                "libreoffice_available": os.path.exists("/usr/bin/libreoffice")
            }
            self.wfile.write(json.dumps(status).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == '/api/pdf-to-docx':
            self.handle_pdf_to_docx()
        elif self.path == '/api/docx-to-pdf':
            self.handle_docx_to_pdf()
        else:
            self.send_response(404)
            self.end_headers()

    def handle_pdf_to_docx(self):
        try:
            content_type = self.headers.get('Content-Type', '')
            if 'boundary=' not in content_type:
                self.send_error(400, "Missing boundary in Content-Type")
                return

            boundary = content_type.split('boundary=')[1].split(';')[0].strip('"')
            content_length = int(self.headers.get('Content-Length', 0))
            body_bytes = self.rfile.read(content_length)

            file_bytes = extract_file_from_multipart(body_bytes, boundary)
            if not file_bytes:
                self.send_error(400, "File content not found in multipart body")
                return

            with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as in_pdf:
                in_pdf.write(file_bytes)
                in_pdf_path = in_pdf.name

            out_docx_path = in_pdf_path.replace('.pdf', '.docx')

            # Use open-source pdf2docx
            from pdf2docx import Converter
            cv = Converter(in_pdf_path)
            cv.convert(out_docx_path, start=0, end=None)
            cv.close()

            with open(out_docx_path, 'rb') as f:
                docx_bytes = f.read()

            # Clean up
            if os.path.exists(in_pdf_path):
                os.remove(in_pdf_path)
            if os.path.exists(out_docx_path):
                os.remove(out_docx_path)

            self.send_response(200)
            self.send_header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
            self.send_header('Content-Disposition', 'attachment; filename="converted.docx"')
            self.send_header('Content-Length', str(len(docx_bytes)))
            self.end_headers()
            self.wfile.write(docx_bytes)

        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))

    def handle_docx_to_pdf(self):
        try:
            content_type = self.headers.get('Content-Type', '')
            if 'boundary=' not in content_type:
                self.send_error(400, "Missing boundary in Content-Type")
                return

            boundary = content_type.split('boundary=')[1].split(';')[0].strip('"')
            content_length = int(self.headers.get('Content-Length', 0))
            body_bytes = self.rfile.read(content_length)

            file_bytes = extract_file_from_multipart(body_bytes, boundary)
            if not file_bytes:
                self.send_error(400, "File content not found in multipart body")
                return

            with tempfile.NamedTemporaryFile(suffix='.docx', delete=False) as in_docx:
                in_docx.write(file_bytes)
                in_docx_path = in_docx.name

            temp_dir = tempfile.gettempdir()
            # Convert using LibreOffice headless
            cmd = [
                'libreoffice',
                '--headless',
                '--convert-to',
                'pdf',
                '--outdir',
                temp_dir,
                in_docx_path
            ]
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

            out_pdf_path = os.path.join(temp_dir, os.path.splitext(os.path.basename(in_docx_path))[0] + '.pdf')

            with open(out_pdf_path, 'rb') as f:
                pdf_bytes = f.read()

            if os.path.exists(in_docx_path):
                os.remove(in_docx_path)
            if os.path.exists(out_pdf_path):
                os.remove(out_pdf_path)

            self.send_response(200)
            self.send_header('Content-Type', 'application/pdf')
            self.send_header('Content-Disposition', 'attachment; filename="converted.pdf"')
            self.send_header('Content-Length', str(len(pdf_bytes)))
            self.end_headers()
            self.wfile.write(pdf_bytes)

        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))

def run():
    print(f"[*] Starting DocStudio Open-Source Conversion Engine on port {PORT}...")
    server = HTTPServer(('127.0.0.1', PORT), ConversionHandler)
    print(f"[+] Engine ready. Connect via http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping engine...")
        server.server_close()

if __name__ == '__main__':
    run()
