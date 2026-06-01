#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Thu Jun 22 12:24:45 2023

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


ITERATIONS=60
HOLDING_TIME=4.5
INITIAL_PRICE=0.1
NFT_per_hive=10
STAKERS=200


def price_kix(x):
    m = 0.1
    a = 0.065
    base = 1.2
    
    price = m*((1+a)**np.emath.logn(base, x))
    
    return price

def price_dat(x):
    
    B = 0.5
    A = 0.000000000044668359215096
    E = 2
    price = B + (A*(x**E))
    
    return price


data=pd.read_csv('data/kix/kix_transactions.csv')

circ=[]
counter=0
current=0
for i in range(61):
    print(i)
    if i==0:
        circ.append(data.iloc[current,1])
        current+=1
    elif counter==5:
        circ.append(data.iloc[current,1])
        counter=0
        current+=1
    else:
        circ.append(np.nan)
        counter+=1

volumes = pd.Series(circ)
volumes = volumes*1000000
volumes.interpolate(inplace=True)

supply = SupplyController_Bonding()

assumptions=TransactionManagement_FromData(data=volumes)

holding_time=HoldingTime_Stochastic()


ap_fiat=AgentPool_Basic(users_controller=1,transactions_controller=assumptions,currency='$')


te=TokenEconomy_Basic(holding_time=HOLDING_TIME,supply=supply,token='kix',fiat='$',
                      initial_price=INITIAL_PRICE,burn_token=False,price_function=PriceFunction_IssuanceCurve,
                      price_function_parameters = {'function':price_kix},name='kix')
te.add_agent_pools([ap_fiat])



assumptions2=TransactionManagement_Channeled(dependency_token_economy=te,fiat_or_token='token',percentage=1/350)
ap_kix=AgentPool_Basic(users_controller=1,transactions_controller=assumptions2,currency='kix')

te_d = TokenEconomy_Dependent(holding_time=HOLDING_TIME,supply=0,token='dat',initial_price=1,burn_token=False,fiat='kix',
                              price_function=PriceFunction_BondingCurve, 
                              price_function_parameters = {'function': price_dat,'max_supply':750000},
                              dependent_token_economy = te,name='dat',ignore_supply_controller=True)
te_d.add_agent_pools([ap_kix])


                              
toc = TokenEcosystem(token_economies=[te,te_d],master='kix')



meta=TokenMetaSimulator(toc)
meta.execute(iterations=ITERATIONS,repetitions=100)
reps=meta.get_data()
reps['fair_price'] = reps['transactions_$_kix']*reps['holding_time_kix']/reps['supply_kix']

series=meta.get_timeseries('kix_price_kix')
series2=meta.get_timeseries('dat_price_dat')

series3=meta.get_timeseries('fair_price')

paok=series[1].kix_price_kix_mean
fair = series3[1].fair_price_mean
plt.close()
plt.plot(fair,label='fair')
plt.plot(paok,label='bonding')
plt.legend()
plt.show()