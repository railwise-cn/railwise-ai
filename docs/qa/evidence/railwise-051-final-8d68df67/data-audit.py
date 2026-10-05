from pathlib import Path
import sqlite3,hashlib,json,datetime,sys
root=Path('/Users/wangjiawei/Documents/WorkWise/docs/qa/evidence/railwise-051-final-8d68df67')
dbroot=Path.home()/'.workgpt/kun/engineering'
result={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'read-only SQLite logical dump SHA256; no record values exported','databases':{}}
for file in sorted(dbroot.glob('*.sqlite3')):
    connection=sqlite3.connect(file.as_uri()+'?mode=ro',uri=True)
    connection.execute('BEGIN')
    tables=connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
    counts={name:connection.execute('SELECT count(*) FROM "'+name.replace('"','""')+'"').fetchone()[0] for (name,) in tables}
    digest=hashlib.sha256()
    for line in connection.iterdump(): digest.update((line+'\n').encode())
    result['databases'][file.name]={'logicalSha256':digest.hexdigest(),'tables':counts}
    connection.close()
out=root/('data-audit-'+sys.argv[1]+'.json')
out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(out)
if sys.argv[1]!='before':
    before=json.loads((root/'data-audit-before.json').read_text())
    changed=[name for name,data in result['databases'].items() if before['databases'].get(name)!=data]
    print(json.dumps({'unchanged':len(result['databases'])-len(changed),'changed':changed}))
