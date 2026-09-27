"""Independent high-precision checks of recorded TypeScript outputs."""
import json
from pathlib import Path
from fractions import Fraction
import mpmath as mp
mp.mp.dps=180
base=Path(__file__).parent

def declared(v):return mp.mpf(float(Fraction(str(v))))

cases={c['id']:c for f in ['huber-exact-cases.json','huber-random-exact-cases.json']for c in json.loads((base/f).read_text())}
huber=json.loads((base/'huber-probe-results.json').read_text());max_score_error=mp.mpf(0);max_true_score=mp.mpf(0)
for result in huber['results']:
    assert result['outcome']=='stationary',result
    model=cases[result['id']]['input'];state=result['lastState'];x=list(map(mp.mpf,result['parameters']))
    a=[list(map(declared,row))for row in model['A']];y=list(map(declared,model['y']));k=declared(model.get('k',1));scale=declared(model.get('scale',1));sig=[scale*declared(v)for v in model.get('sigma',[1]*len(y))];p=len(x)
    u=[(yi-sum(ai[j]*x[j]for j in range(p)))/si for ai,yi,si in zip(a,y,sig)]
    score=[]
    for j in range(p):
        column=[ai[j]/si for ai,si in zip(a,sig)];norm=mp.sqrt(sum(v*v for v in column))
        score.append(sum(b/norm*max(-1,min(1,ui/k))for b,ui in zip(column,u)))
    score_inf=max(map(abs,score));max_true_score=max(max_true_score,score_inf)
    err=max(abs(v-mp.mpf(state['normalizedScore'][j]))for j,v in enumerate(score));max_score_error=max(max_score_error,err)
    assert err<=mp.mpf(state['scoreRoundoffEstimate']),(result,err)
    assert score_inf<=declared(1e-10),(result,score_inf)
    assert state['normalizedScoreInfinity']+state['scoreRoundoffEstimate']<=1e-10
    objective=sum(ui*ui/2 if abs(ui)<=k else k*(abs(ui)-k/2)for ui in u)
    assert abs(objective-mp.mpf(state['objective']))<=mp.mpf(state['objectiveRoundoffEstimate']),(result,objective)
    if cases[result['id']]['multipleExactMinimizersFound']:assert result['uniqueness']=='not-established'

summary={'exactPartitionCases':len(cases),'stationaryCases':len(huber['results']),'maxTrueNormalizedScoreInfinity':float(max_true_score),'maxScoreDifferenceVs180DigitEvaluation':float(max_score_error),'allScoreErrorsWithinReportedBudget':True,'allObjectivesWithinReportedBudget':True,'falseUniquenessFindings':0}
(base/'huber-oracle-audit-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))
