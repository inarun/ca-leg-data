import sys, zipfile, time, re, collections, io
sys.stdout.reconfigure(encoding="utf8", errors="replace")
C = collections.Counter
t0 = time.time()
z = zipfile.ZipFile(sys.argv[1])
infos = z.infolist()
grp = collections.defaultdict(lambda: [0, 0, 0])
for i in infos:
    k = re.sub(r'_\d+\.lob$', '_N.lob', i.filename)
    g = grp[k]; g[0] += 1; g[1] += i.compress_size; g[2] += i.file_size
print("ENTRIES", len(infos), "uncompressed MB", sum(i.file_size for i in infos) // 2**20)
for k in sorted(grp): print(f"  {k:36s} n={grp[k][0]:7d} zipMB={grp[k][1]/2**20:8.1f} rawMB={grp[k][2]/2**20:8.1f}")

def rows(name):
    data = z.read(name).decode('utf8', errors='replace')
    out = []; row = []; i = 0; n = len(data); bad = 0
    while i < n:
        if data[i] == '`':
            j = i + 1
            while True:
                j = data.find('`', j)
                if j == -1: j = n; break
                if j + 1 >= n or data[j + 1] in '\t\n\r': break
                j += 1
            row.append(data[i + 1:j]); i = j + 1
        else:
            j = i
            while j < n and data[j] not in '\t\n': j += 1
            v = data[i:j].rstrip('\r'); row.append(None if v == 'NULL' else v); i = j
        if i < n and data[i] == '\r': i += 1
        if i >= n or data[i] == '\n':
            out.append(row); row = []; i += 1
        elif data[i] == '\t': i += 1
    if row: out.append(row)
    return out

def show(title, c, n=40):
    print(f"\n## {title} (distinct={len(c)})")
    for k, v in c.most_common(n): print(f"  {v:8d}  {k}")

bills = rows('BILL_TBL.dat')
print("\nBILL_TBL rows", len(bills), "cols", C(len(r) for r in bills))
print("  sample", bills[0])
show("measure_type", C(r[3] for r in bills))
show("measure_state", C(r[5] for r in bills))
show("current_status", C(r[17] for r in bills))
show("current_house", C(r[16] for r in bills))
show("session_year/num", C((r[1], r[2]) for r in bills))
bt = {r[0]: r for r in bills}

ver = rows('BILL_VERSION_TBL.dat')
print("\nBILL_VERSION_TBL rows", len(ver), "cols", C(len(r) for r in ver))
print("  sample", ver[0])
show("bill_version_action", C(r[4] for r in ver))
pv = C(r[1] for r in ver)
show("versions per bill", C(pv.values()), 15)
print("  bills without versions:", len(set(bt) - set(pv)))

an = rows('BILL_ANALYSIS_TBL.dat')
print("\nBILL_ANALYSIS_TBL rows", len(an), "cols", C(len(r) for r in an))
show("house/type/committee", C((r[2], r[3], r[5]) for r in an), 80)
ab = set(r[1] for r in an)
for mt in ('AB', 'SB'):
    tot = [b for b in bt if bt[b][3] == mt and bt[b][2] == '0']
    print(f"  {mt} regular-session bills {len(tot)}; with >=1 analysis {sum(1 for b in tot if b in ab)}")
show("active_flg", C(r[12] for r in an))

mo = {r[0]: r[1] for r in rows('BILL_MOTION_TBL.dat')}
sv = rows('BILL_SUMMARY_VOTE_TBL.dat')
print("\nBILL_SUMMARY_VOTE_TBL rows", len(sv), "cols", C(len(r) for r in sv), "motions", len(mo))
print("  sample", sv[0])
show("location_code", C(r[1] for r in sv), 60)
floor = [r for r in sv if r[1] in ('AFLOOR', 'SFLOOR')]
show("FLOOR motion text", C((r[1], mo.get(r[4], '?' + str(r[4]))) for r in floor), 70)
show("vote_result", C(r[8] for r in sv))
show("file_location (floor)", C(r[12] for r in floor), 30)

dv = rows('BILL_DETAIL_VOTE_TBL.dat')
print("\nBILL_DETAIL_VOTE_TBL rows", len(dv), "cols", C(len(r) for r in dv))
print("  sample", dv[0])
show("vote_code", C(r[5] for r in dv))
# completeness: detail tallies vs summary
key = lambda b, loc, dt, seq, m: (b, loc, dt, str(seq), str(m))
tal = collections.defaultdict(C)
for r in dv: tal[key(r[0], r[1], r[3], r[4], r[6])][r[5]] += 1
ok = mism = missing = 0; ex = []
for r in sv:
    k = key(r[0], r[1], r[2], r[3], r[4])
    if k not in tal: missing += 1; ex.append(('MISSING', r[:9])); continue
    t = tal[k]
    if str(t.get('AYE', 0)) == str(r[5]) and str(t.get('NOE', 0)) == str(r[6]): ok += 1
    else: mism += 1; ex.append(('MISMATCH', r[:9], dict(t)))
print(f"\n  summary votes: tallies match detail={ok} mismatch={mism} no detail rows={missing}; detail keys without summary={len(set(tal) - set(key(r[0], r[1], r[2], r[3], r[4]) for r in sv))}")
for e in ex[:8]: print("   ", e)
fk = [key(r[0], r[1], r[2], r[3], r[4]) for r in floor]
show("floor vote size (members recorded per roll call)", C((k[1], sum(tal[k].values())) for k in fk if k in tal), 20)
dup = C(key(r[0], r[1], r[2], r[3], r[4]) for r in sv)
print("  duplicate summary keys:", sum(1 for v in dup.values() if v > 1))

leg = rows('LEGISLATOR_TBL.dat')
print("\nLEGISLATOR_TBL rows", len(leg), "cols", C(len(r) for r in leg))
for r in leg[:4]: print("  ", r)
show("house/active_flg/active_legislator", C((r[3], r[12], r[15]) for r in leg))
show("session_year", C(r[1] for r in leg))
dd = C((r[3], r[0]) for r in leg)
print("  districts with >1 row:", [(k, v) for k, v in dd.items() if v > 1])
names = {}
for r in leg: names.setdefault((r[3], r[4] or ''), []).append(r[0])
print("  legislator_name collisions within a house:", [(k, v) for k, v in names.items() if len(v) > 1])
fn = collections.defaultdict(set)
for r in dv:
    if r[1] in ('AFLOOR', 'SFLOOR'): fn[r[1][0]].add(r[2])
for h in 'AS':
    known = set(n for (hh, n) in names if hh == h)
    print(f"  {h} floor: distinct voter names {len(fn[h])}; not in LEGISLATOR_TBL.legislator_name: {sorted(fn[h] - known)}")
    print(f"     legislators never appearing in floor votes: {sorted(known - fn[h])}")

# chaptered bills: floor votes in both houses?
fb = collections.defaultdict(set)
for r in floor: fb[r[0]].add(r[1])
ch = [b for b in bt if bt[b][5] == 'Chaptered' and bt[b][3] in ('AB', 'SB')]
print(f"\nChaptered AB/SB {len(ch)}; with floor votes in both houses {sum(1 for b in ch if len(fb[b]) == 2)}; one house {sum(1 for b in ch if len(fb[b]) == 1)}; none {sum(1 for b in ch if len(fb[b]) == 0)}")
print("   examples lacking:", [b for b in ch if len(fb[b]) < 2][:10])

import re as _re
def cls(r):
    m = mo.get(r[4], ''); 
    m2 = _re.sub(r'(AB|SB|ACA|SCA|ACR|SCR|AJR|SJR|HR|SR)\s?\d+.*?(?=(Assembly|Senate|Concurrence|Consent|Third|Motion|Urgency|$))', '<BILL> ', m)
    return (r[1], r[12], _re.sub(r'By [A-Z].*$', 'By <NAME>', m2).strip())
show("FLOOR motion classes (file_location, normalized motion)", C(cls(r) for r in floor), 60)
loc = rows('LOCATION_CODE_TBL.dat')
print("LOCATION codes AF*:", [(r[1], r[4]) for r in loc if r[1].startswith('AF') or r[1] in ('AFLOOR','SFLOOR')][:40])
show("location_type", C(r[2] for r in loc))
print("committees:", [(r[1], r[4]) for r in loc if r[1][:2] in ('CS','CX')])
show("bills by type among floor votes", C(bt[r[0]][3] for r in floor if r[0] in bt))
nfl = collections.defaultdict(C)
for r in floor: nfl[r[0]][r[1]] += 1
show("AB/SB chaptered: (#AFLOOR,#SFLOOR) roll calls", C((nfl[b]['AFLOOR'], nfl[b]['SFLOOR']) for b in ch), 20)
va = rows('BILL_VERSION_AUTHORS_TBL.dat'); show("authors type/contribution", C((r[1], r[2], r[4]) for r in va), 20)
hi = rows('BILL_HISTORY_TBL.dat')
print("\nBILL_HISTORY_TBL rows", len(hi), "cols", C(len(r) for r in hi)); print("  sample", hi[0])
show("action_status", C(r[8] for r in hi), 30)
show("end_status", C(r[12] for r in hi), 30)
for nm in ('COMMITTEE_HEARING_TBL.dat', 'DAILY_FILE_TBL.dat', 'LOCATION_CODE_TBL.dat', 'VETO_MESSAGE_TBL.dat', 'BILL_VERSION_AUTHORS_TBL.dat'):
    try:
        r = rows(nm); print(f"\n{nm} rows {len(r)} cols {C(len(x) for x in r)}"); print("  sample", [str(c)[:80] if c else c for c in r[0]])
    except KeyError: print(nm, "ABSENT")
print("\nmax dates: summary vote", max(r[2] for r in sv), "| history", max(r[2] for r in hi if r[2]), "| version", max(r[3] for r in ver), "| analysis", max(r[7] for r in an if r[7]))
print("ELAPSED s", round(time.time() - t0, 1))
