"""A stand-in for the three GitHub release endpoints the mirror job calls. Records every request."""
import json, os, re, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

port, state_dir = int(sys.argv[1]), sys.argv[2]
os.makedirs(os.path.join(state_dir, 'uploads'), exist_ok=True)
releases = {}  # tag -> {"id", "tag_name", "assets": [...]}


def log(line):
    with open(os.path.join(state_dir, 'requests.log'), 'a') as f:
        f.write(line + '\n')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorised(self):
        if self.headers.get('Authorization') != 'Bearer fixture-pat':
            self.reply(401, {'message': 'Bad credentials'})
            return False
        return True

    def do_GET(self):
        log('GET ' + self.path)
        if not self.authorised():
            return
        m = re.search(r'/releases/tags/([^/]+)$', urlparse(self.path).path)
        if m:
            tag = m.group(1)
            if tag in releases:
                return self.reply(200, releases[tag])
            return self.reply(404, {'message': 'Not Found'})
        self.reply(404, {'message': 'Not Found'})

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(length)
        log('POST ' + self.path)
        if not self.authorised():
            return
        url = urlparse(self.path)
        assets = re.search(r'/releases/(\d+)/assets$', url.path)
        if url.path.endswith('/releases'):
            doc = json.loads(body)
            if doc['tag_name'] in releases:
                return self.reply(422, {'message': 'already_exists'})
            rel = {'id': len(releases) + 1, 'tag_name': doc['tag_name'], 'draft': doc['draft'], 'prerelease': doc['prerelease'], 'assets': []}
            releases[doc['tag_name']] = rel
            log('CREATED ' + json.dumps(doc, sort_keys=True))
            return self.reply(201, rel)
        if assets:
            rid = int(assets.group(1))
            name = parse_qs(url.query)['name'][0]
            rel = next(r for r in releases.values() if r['id'] == rid)
            rel['assets'].append({'name': name, 'size': len(body)})
            with open(os.path.join(state_dir, 'uploads', rel['tag_name'] + '__' + name), 'wb') as f:
                f.write(body)
            return self.reply(201, {'name': name})
        self.reply(404, {'message': 'Not Found'})


HTTPServer(('127.0.0.1', port), Handler).serve_forever()
