"""M0 spike: Digest coverage, analysis text size, statute text, nightly-file check.
Usage: python -I measure_text.py <pubinfo zip>   (standard library only)"""
import sys, zipfile, re, time, html, io, gzip, json
sys.stdout.reconfigure(encoding="utf8", errors="replace")
t0 = time.time()
z = zipfile.ZipFile(sys.argv[1])
def lines(n): return [l.split('\t') for l in z.read(n).decode('utf8', 'replace').split('\n') if l]
q = lambda s: s.strip('`')
bills = lines('BILL_TBL.dat')
latest = {q(f[0]): q(f[10]) for f in bills}
mtype = {q(f[0]): q(f[3]) for f in bills}
vlob = {q(f[0]): f[14] for f in lines('BILL_VERSION_TBL.dat') if len(f) > 14}
dig = {}; nodig = {}
for b, v in latest.items():
    x = z.read(vlob[v]).decode('utf8', 'replace')
    m = re.search(r'<caml:DigestText>(.*?)</caml:DigestText>', x, re.S)
    if m: dig[b] = html.unescape(re.sub(r'<[^>]+>', '', m.group(1)))
    else: nodig[mtype[b]] = nodig.get(mtype[b], 0) + 1
dj = json.dumps(dig).encode()
print(f"DIGEST: measures {len(latest)}; with caml:DigestText {len(dig)}; without {sum(nodig.values())} by type {nodig}")
print(f"DIGEST: json MB {len(dj)/2**20:.1f}; gzip MB {len(gzip.compress(dj))/2**20:.1f}")
best = {}
for f in lines('BILL_ANALYSIS_TBL.dat'):
    if len(f) < 11: continue
    b = q(f[1]); k = (f[7], f[0])
    if b not in best or k > best[b][0]: best[b] = (k, f[10])
texts = {}; bad = 0; sup = opp = args = digp = 0
for b, (k, lob) in best.items():
    try: d = zipfile.ZipFile(io.BytesIO(z.read(lob))).read('word/document.xml').decode('utf8')
    except Exception: bad += 1; continue
    t = html.unescape(re.sub(r'<[^>]+>', '', re.sub(r'</w:p>', '\n', d))); texts[b] = t
    sup += bool(re.search(r'SUPPORT', t)); opp += bool(re.search(r'OPPOSITION|OPPOSE', t))
    args += bool(re.search(r'ARGUMENTS? IN SUPPORT', t)); digp += bool(re.search(r'^\s*(DIGEST|SUMMARY)\s*:', t, re.M))
tj = json.dumps(texts).encode()
print(f"ANALYSIS: bills with >=1 analysis {len(best)}; latest parsed as docx {len(texts)}; not docx {bad}")
print(f"ANALYSIS: latest-per-bill text MB {sum(map(len, texts.values()))/2**20:.1f}; gzip MB {len(gzip.compress(tj))/2**20:.1f}")
print(f"ANALYSIS: contains SUPPORT {sup}; OPPOSITION/OPPOSE {opp}; 'ARGUMENTS IN SUPPORT' {args}; DIGEST:/SUMMARY: line {digp}")
for i, l in enumerate(z.read('LAW_SECTION_TBL.dat').decode('utf8', 'replace').split('\n')) if 'LAW_SECTION_TBL.dat' in z.namelist() else []:
    f = l.split('\t')
    if len(f) > 14 and f[1] == '`GOV`' and f[2] in ('`10248.`', '`10248.5.`'):
        t = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', z.read(f[14]).decode('utf8', 'replace'))))
        print(f"\nLAW_SECTION_TBL.dat row {i+1} {f[0]} section {f[2]} history {f[13]}\n{t}")
print("\nELAPSED s", round(time.time() - t0, 1))
