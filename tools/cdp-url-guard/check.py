#!/usr/bin/env python3
"""Fail when code outside the CDP URL helpers builds a browser URL by hand, which loses the access token."""

import re
import subprocess
import sys

# The helpers may change CDP URLs; each other line must call them.
HELPERS = {
	'tools/cdp-url-guard/check.py',
}
# Each entry is a path and a text that the flagged line holds.
ALLOWED = []
CODE = re.compile(r'\.(go|py|ts|tsx|js|jsx|mjs|cjs|html)$')
TEST = re.compile(r'(_test\.go|\.test\.\w+|\.spec\.\w+|(^|/)test_[^/]*\.py|_test\.py)$|(^|/)(tests?|__tests__|testdata|fixtures)/')
RULES = [
	('our CDP domain', re.compile(r'\.cdp\.(browser-use|eu\.browser-use|fuego)'), False),
	('driver port joined to a URL', re.compile(r':6969\b|JoinHostPort\(.*6969|USE_BROWSER_API_PORT(?!\s*(:\s*)?(\w+\s*)?:?=[^=])'), False),
	('/json path joined to a URL', re.compile(r'''(\+\s*["'`]|\}|%s|%v)/json/(version|list)|(new URL\(\s*["'`]|urljoin\(.*["'])/?json/(version|list)'''), False),
	(
		'URL built from a host read',
		re.compile(
			r'''//[^"'`\n]*(\{[^}]*|(%s|\{\})[^"'`\n]*["'`]\s*(,|%|\.format\()[^\n]*|["'`]\s*\+\s*[\w.]*)\b(Host|host|hostname|Hostname|netloc|origin)\b'''
		),
		True,
	),
]


def main() -> int:
	files = subprocess.run(['git', 'ls-files'], capture_output=True, text=True, check=True).stdout.split('\n')
	failures = []
	for path in files:
		if not CODE.search(path) or TEST.search(path) or path in HELPERS:
			continue
		try:
			text = open(path, encoding='utf-8').read()
		except (OSError, UnicodeDecodeError):
			continue
		mentions_cdp = 'cdp' in text.lower()
		for number, line in enumerate(text.split('\n'), 1):
			for name, pattern, needs_cdp in RULES:
				if needs_cdp and not mentions_cdp or not pattern.search(line):
					continue
				if any(path == allowed and part in line for allowed, part in ALLOWED):
					continue
				failures.append(f'{path}:{number}: {name}: {line.strip()[:160]}')
	for failure in failures:
		print(failure)
	if failures:
		print('\nBuild CDP URLs with the CDP URL helper, so the token query stays (section 3.7 of https://github.com/browser-use/glut/blob/plan/cdp-url-auth/docs/cdp-url-auth-plan.md).')
	return 1 if failures else 0


if __name__ == '__main__':
	sys.exit(main())
