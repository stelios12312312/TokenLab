#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Sat Jul 22 10:43:49 2023

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


blur = pd.read_csv('data/spaace/blur-usd-max.csv').iloc[0:120,:]
looks = pd.read_csv('data/spaace/looks-usd-max.csv').iloc[0:120,:]

blur_diff = blur.market_cap.diff()/blur.market_cap
looks_diff = looks.market_cap.diff()/looks.market_cap

PERC_SUPPLY=0.5
ITERATIONS=90
#TIME IS IN DAYS FOR THIS SIMULATION
HOLDING_TIME=0
INITIAL_PRICE=0.4
supply = np.ndarray.flatten(pd.read_csv('data/spaace/supply.csv').astype('float32').values).tolist()
supply+=[supply[-1]]*30
supply=np.array(supply)
SUPPLY = SupplyController_FromData(supply)

revenues= supply*np.abs(np.random.randn()*0.1)*PERC_SUPPLY


assumptions=TransactionManagement_MarketcapStochastic(distribution_params = {'loc':0,'scale':0.04},sign='negative')
assumptions2 = TransactionManagement_Assumptions(data=revenues)
holding_time=HoldingTime_Stochastic(distribution=scipy.stats.lognorm,
                                    holding_time_params={'loc':HOLDING_TIME,'s':1})


ap_fiat=AgentPool_Basic(users_controller=1,transactions_controller=assumptions,currency='$')
ap_fiat2=AgentPool_Basic(users_controller=1,transactions_controller=assumptions2,currency='$')


te=TokenEconomy_Basic(holding_time=holding_time,supply=SUPPLY,token='tokenA',
                      initial_price=INITIAL_PRICE,burn_token=False,unit_of_time='day', 
                        price_function=PriceFunction_LinearRegression
                      )

te.add_agent_pools([ap_fiat,ap_fiat2])

meta=TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS,repetitions=100)
reps=meta.get_data()

meta.get_timeseries('tokenA_price')