import json,math
from pathlib import Path
import mpmath as mp
import importlib.util
_oracle_spec=importlib.util.spec_from_file_location("statistical_review_oracle",Path(__file__).with_name("survey-statistical-family-review-oracle.py"))
_oracle=importlib.util.module_from_spec(_oracle_spec)
_oracle_spec.loader.exec_module(_oracle)
probability=_oracle.probability
mp.mp.dps=180

def tail(kind,x,df):
 if kind=='normal':return mp.erfc(x/mp.sqrt(2))
 if kind=='student-t':return mp.betainc(mp.mpf(df)/2,mp.mpf('.5'),0,mp.mpf(df)/(df+x*x),regularized=True)
 return mp.gammainc(mp.mpf(df)/2,x/2,mp.inf,regularized=True)

def quantile(kind,target,df):
 low=mp.mpf(0);high=mp.mpf(1)
 while tail(kind,high,df)>target:high*=2
 for _ in range(350):
  mid=(low+high)/2
  if tail(kind,mid,df)>target:low=mid
  else:high=mid
 return (low+high)/2

cases=[]
for kind,dfs in [('normal',[None]),('student-t',[1,2,10,1000]),('chi-square',[1,2,10,1000])]:
 for df in dfs:
  for alpha,m in [(.05,1),(.05,256),(1e-12,256),(.5,1),(.5,256)]:
   target=mp.mpf(float(alpha))/m;q=quantile(kind,target,df);f=float(q)
   cases.append({'kind':kind,'df':df,'alpha':alpha,'familySize':m,'target120':mp.nstr(target,118),'quantile120':mp.nstr(q,100),'nearest':f,'predecessor':math.nextafter(f,0),'successor':math.nextafter(f,math.inf),'farBelow':f*(1-1e-7),'farAbove':f*(1+1e-7)})
Path(__file__).with_name('survey-statistical-family-review-critical-cases.json').write_text(json.dumps(cases,indent=2)+'\n')
print(json.dumps({'criticalCases':len(cases),'bitsBisection':350,'precision':180}))
