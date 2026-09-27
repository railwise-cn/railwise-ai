import random,json,math
from pathlib import Path
import importlib.util
_oracle_spec=importlib.util.spec_from_file_location("statistical_review_oracle",Path(__file__).with_name("survey-statistical-family-review-oracle.py"))
_oracle=importlib.util.module_from_spec(_oracle_spec)
_oracle_spec.loader.exec_module(_oracle)
record=_oracle.record
rng=random.Random(20260921);cases=[]
for i in range(600):
 kind=['normal','student-t','chi-square'][i%3];df=rng.randrange(1,1001)
 if kind=='normal':x=rng.uniform(-35,35);df=None
 elif kind=='student-t':x=(-1 if rng.randrange(2) else 1)*10**rng.uniform(-14,16)
 else:x=rng.uniform(.01,2)*df if i%2 else 10**rng.uniform(-14,6)
 cases.append(record(kind,x,df,'seeded-random'))
Path(__file__).with_name('survey-statistical-family-review-random-cases.json').write_text(json.dumps(cases,indent=2)+'\n')
print(len(cases))
