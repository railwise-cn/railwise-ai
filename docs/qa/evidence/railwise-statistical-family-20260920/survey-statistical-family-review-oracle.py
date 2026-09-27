"""118-digit independent tail references from 180-digit arithmetic; mpmath 1.3.0.
Normal uses erfc; t uses regularized incomplete beta; chi-square uses
upper incomplete gamma. These are separate library algorithms, not copied
from the TypeScript implementation. Closed-form df1/df2 checks are recorded.
"""
import json,math
from pathlib import Path
import mpmath as mp
mp.mp.dps=180

def probability(kind,x,df=None):
    x=mp.mpf(float(x)) # exact IEEE-double input, not its ideal decimal spelling
    if kind=='normal':return mp.erfc(abs(x)/mp.sqrt(2))
    if kind=='student-t':return mp.betainc(mp.mpf(df)/2,mp.mpf('0.5'),0,mp.mpf(df)/(df+x*x),regularized=True)
    return mp.gammainc(mp.mpf(df)/2,x/2,mp.inf,regularized=True)

def record(kind,x,df=None,label=None):
    p=probability(kind,x,df)
    assert 0<=p<=1
    item={'kind':kind,'statistic':x,'df':df,'p120':mp.nstr(p,118),'logP120':mp.nstr(mp.log(p),118),'label':label or 'grid'}
    if kind=='student-t' and df==1 and x:
        exact=2*mp.atan(1/abs(mp.mpf(float(x))))/mp.pi
        assert mp.almosteq(p,exact,rel_eps=mp.mpf('1e-110'))
        item['closedForm']='2*atan(1/abs(t))/pi'
    if kind=='student-t' and df==2:
        t=abs(mp.mpf(float(x)));r=mp.sqrt(t*t+2);exact=2/(r*(r+t))
        assert mp.almosteq(p,exact,rel_eps=mp.mpf('1e-110'))
        item['closedForm']='2/(sqrt(t*t+2)*(sqrt(t*t+2)+abs(t)))'
    if kind=='chi-square' and df==2:
        assert mp.almosteq(p,mp.exp(-mp.mpf(float(x))/2),rel_eps=mp.mpf('1e-110'))
        item['closedForm']='exp(-x/2)'
    return item

if __name__=='__main__':
    results=[]
    for x in [0,math.nextafter(0,1),1e-12,.1,.5,1,1.959963984540054,7,7.9,8,10,20,26,35]:
        for sign in ([1,-1] if x else [1]):results.append(record('normal',sign*x))
    for df in [1,2,3,5,10,30,100,300,1000]:
        for x in [0,1e-12,.1,1,2,10,30,100,1e3,1e8,1e16]:results.append(record('student-t',x,df))
        for x in sorted(set([0,1e-12,.1,1,df*.5,df,df+2-1e-8,df+2,df+2+1e-8,df+10*math.sqrt(2*df),100,1e3,1e6])):results.append(record('chi-square',x,df))
    Path(__file__).with_name('survey-statistical-family-review-tail-cases.json').write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps({'cases':len(results),'precision':mp.mp.dps,'closedForms':sum('closedForm'in r for r in results)}))
