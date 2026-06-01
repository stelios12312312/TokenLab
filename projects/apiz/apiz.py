#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Sat Jun  3 15:29:15 2023

@author: stylianoskampakis
"""

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
from TokenLab.simulationcomponents.supplyclasses import *
from TokenLab.simulationcomponents.addons import AddOn_RandomNoise, AddOn_RandomNoiseProportional
from TokenLab.utils.helpers import *
from matplotlib import pyplot as plt

ITERATIONS=12*3
HOLDING_TIME=12
INITIAL_PRICE=0.1
NFT_per_hive=10
STAKERS=200


data=pd.read_csv('data/apiz/data.csv')
initial_value = data['Circulating Supply'].values[0]
diffs=data.loc[:,'Circulating Supply'].diff()
diffs[0]=initial_value
data.loc[:,'Circulating Supply']=diffs
# data['Circulating Supply'].plot()

# circ=[]
# counter=0
# current=0
# for i in range(data.shape[0]):
#     print(i)
#     if i==0:
#         circ.append(data.iloc[current,1])
#         current+=1
#     elif counter==2:
#         circ.append(data.iloc[current,1])
#         counter=0
#         current+=1
#     else:
#         circ.append(np.nan)
#         counter+=1
        
# data['Circulating Supply'] = circ
# data['Circulating Supply'].fillna(inplace=True,method='ffill')
    

supply = SupplyController_FromData(data['Circulating Supply'].dropna().values)

revenues = data['Bee hives']*50000*NFT_per_hive

assumptions=TransactionManagement_FromData(data=revenues)
holding_time=HoldingTime_Stochastic()

# ap_fiat=AgentPool_Basic(users_controller=1,transactions_controller=assumptions,currency='tokenA')



# te=TokenEconomy_Basic(holding_time=holding_time,supply=supply,token='tokenA',
#                       initial_price=INITIAL_PRICE,burn_token=False,price_function_parameters={'smoothing_param':0.5},
#                       supply_pools=stakers)
# te.add_agent_pools([ap_fiat])

# meta=TokenMetaSimulator(te)
# meta.execute(iterations=ITERATIONS,repetitions=100)
# reps=meta.get_data()

# meta.get_timeseries('tokenA_price',log_scale=False)


#####Staking pools
supply = SupplyController_FromData(data['Circulating Supply'].dropna().values)

ap_fiat=AgentPool_Staking(users_controller=STAKERS,transactions_controller=50000,currency='tokenA',
                          staking_controller=SupplyStakerLockup,staking_controller_params={'staking_amount':50000,
                                                                                     'rewards':50000*0.05,
                                                                                     'lockup_duration':12})



te=TokenEconomy_Basic(holding_time=HOLDING_TIME,supply=supply,token='tokenA',
                      initial_price=INITIAL_PRICE,burn_token=False,price_function_parameters={'smoothing_param':0.5},
                      supply_is_added=True)

te.add_agent_pools([ap_fiat])

meta=TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS,repetitions=100)
reps=meta.get_data()

meta.get_timeseries('tokenA_price')