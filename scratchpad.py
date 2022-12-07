import numpy as np
import scipy
import sys
sys.path.insert(0,'..')

from simulationcomponents import *
from simulationcomponents.usergrowthclasses import *
from simulationcomponents.transactionclasses import *
from simulationcomponents.tokeneconomyclasses import *
from simulationcomponents.transactionclasses import *
from simulationcomponents.agentpoolclasses import *
from simulationcomponents.pricingclasses import *
from simulationcomponents.supplyclasses import *
from simulationcomponents.addons import Condition
from utils.helpers import *
from matplotlib import pyplot as plt
from analytics.analyticsfunctions import *


ITERATIONS=60
HOLDING_TIME=HoldingTime_Adaptive(1)
SUPPLY=10**7
INITIAL_PRICE=1

usm_fiat=UserGrowth_Spaced(100,54000,ITERATIONS,log_saturated_space)
tsm_fiat=TransactionManagement_Stochastic(activity_probs=np.linspace(0.25,1,ITERATIONS),
                                            value_dist_parameters={'loc':1000,'scale':200},
                                           transactions_dist_parameters={'mu':1})

ap_fiat=AgentPool_Basic(users_controller=usm_fiat,transactions_controller=tsm_fiat,currency='$')

te=TokenEconomy_Basic(holding_time=HoldingTime_Stochastic(),supply=SUPPLY,token='tokenA',initial_price=INITIAL_PRICE)
te.add_agent_pools([ap_fiat])
meta=TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS,repetitions=50)
reps=meta.get_data()
plot,data=meta.get_timeseries('tokenA_price')
plot

X=reps.loc[:,['transactions_$','num_users','holding_time','effective_holding_time','supply','transactions_tokenA']]
#X_squared=X**2
#X_squared.columns+='^2'
#X=pd.concat([X,X_squared],axis=1)
y=reps['tokenA_price'].values

model=stepwise_selection(X,y,initial_list=['transactions_$','num_users','holding_time',
                                           'effective_holding_time','supply','transactions_tokenA'])

print(model[0].summary())