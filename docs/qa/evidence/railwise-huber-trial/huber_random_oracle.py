from huber_fraction_oracle import exact
from pathlib import Path
import random,json
rng=random.Random(20260920)
cases=[]
for index in range(48):
    p=1 if index<12 else 2;n=rng.randrange(4,8)
    a=[[1]if p==1 else [1,i]for i in range(n)]
    model={'id':f'random-{index}','A':a,'y':[rng.randrange(-12,13)for _ in range(n)],'sigma':[rng.choice([1,2,3])for _ in range(n)],'scale':rng.choice([1,2]),'k':rng.choice([1,2,3])}
    cases.append(exact(model))
Path(__file__).with_name('huber-random-exact-cases.json').write_text(json.dumps(cases,indent=2)+'\n')
print(json.dumps({'cases':len(cases),'multipleMinimizersFound':sum(x['multipleExactMinimizersFound']for x in cases)}))
