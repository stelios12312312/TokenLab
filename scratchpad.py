#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Nov 18 20:31:40 2022

@author: stylianoskampakis
"""
import numpy as np
import scipy

from simulationcomponents import *
from simulationcomponents.usergrowthclasses import *
from simulationcomponents.transactionclasses import *
from simulationcomponents.tokeneconomyclasses import *
from simulationcomponents.transactionclasses import *
from simulationcomponents.agentpoolclasses import *
from utils.helpers import *

ITERATIONS=60
HOLDING_TIME=HoldingTime_Adaptive(1)
SUPPLY=10000000
INITIAL_PRICE=0.1


usm_fiat=UserGrowth_Spaced(100,54000,ITERATIONS,log_saturated_space)
tsm_fiat=TransactionManagement_Stochastic(activity_probs=np.linspace(0.25,1,ITERATIONS),
                                            value_dist_parameters={'loc':1000,'scale':200},
                                           transactions_dist_parameters={'mu':1})

ap_fiat=AgentPool_Basic(users_controller=usm_fiat,transactions_controller=tsm_fiat,currency='$')

usm_token=UserGrowth_Spaced(10,54000,ITERATIONS,np.linspace)
ap_token=AgentPool_Basic(users_controller=usm_token,transactions_controller=100,currency='tokenA')

usm_sellers=UserGrowth_Spaced(10,5400,ITERATIONS,np.linspace)
tsm_sellers=TransactionManagement_Stochastic(type_transaction='negative',activity_probs=np.linspace(0.5,1,ITERATIONS),
                                            value_dist_parameters={'loc':-1000,'scale':200},
                                           transactions_dist_parameters={'mu':3})
ap_sellers=AgentPool_Basic(users_controller=usm_sellers,transactions_controller=tsm_sellers,currency='tokenA',name='sellers')


te=TokenEconomy_Basic(holding_time=HOLDING_TIME,supply=SUPPLY,token='tokenA',initial_price=INITIAL_PRICE)
te.add_agent_pools([ap_fiat,ap_token,ap_sellers])
meta=TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS,repetitions=50)
reps=meta.get_data()
plot,data=meta.get_timeseries('tokenA_price')
plot