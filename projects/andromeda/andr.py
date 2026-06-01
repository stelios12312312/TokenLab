import numpy as np
import scipy
import sys
import os

import pandas as pd

tokenlab_path=os.path.abspath("").replace('projects','src')
sys.path.insert(0,tokenlab_path)


from TokenLab.simulationcomponents import *
from TokenLab.simulationcomponents.usergrowthclasses import *
from TokenLab.simulationcomponents.transactionclasses import *
from TokenLab.simulationcomponents.tokeneconomyclasses import *
from TokenLab.simulationcomponents.transactionclasses import *
from TokenLab.simulationcomponents.agentpoolclasses import *
from TokenLab.simulationcomponents.pricingclasses import *
from TokenLab.simulationcomponents.addons import AddOn_RandomNoise, AddOn_RandomNoiseProportional
from TokenLab.utils.helpers import *
from matplotlib import pyplot as plt

ITERATIONS=12*5
HOLDING_TIME=1
SUPPLY=10**8
INITIAL_PRICE=0.01


random_noise=AddOn_RandomNoiseProportional(std_param=5)

lr=lambda start,stop,num : logistic_saturated_space(start=start,stop=stop,num=num,steepness=4)

users=UserGrowth_Spaced(initial_users=100000,max_users=750000,num_steps=60,
                        #space_function=lr
                        #,noise_addon=random_noise
                        )


plt.plot(users.get_users_store())

transactions=TransactionManagement_Stochastic(value_distribution=scipy.stats.norm,
                                             value_dist_parameters={'loc':50,'scale':800},
                                              transactions_constant=1,activity_probs=0.5,
                                             type_transaction='mix')




locs=generate_distribution_param_from_sequence(param_name='loc',start=0,stop=9,num=18)
scales=generate_distribution_param_from_sequence(param_name='scale',start=0,stop=2,num=18)
params=merge_param_dists(locs,scales)

#holding_time=HoldingTime_Stochastic(holding_time_params=params)
holding_time=1



ap_fiat=AgentPool_Basic(users_controller=users,transactions_controller=transactions,currency='$')


te=TokenEconomy_Basic(holding_time=holding_time,supply=SUPPLY,token='tokenA',
                      initial_price=INITIAL_PRICE,burn_token=True)
te.add_agent_pools([ap_fiat])

meta=TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS,repetitions=100)
reps=meta.get_data()

meta.get_timeseries('tokenA_price')