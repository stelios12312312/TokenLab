#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Dec  8 12:02:05 2023

@author: stylianoskampakis
"""
import numpy as np
import scipy
import sys
import os
import pandas as pd
from matplotlib import pyplot as plt

tokenlab_path = os.path.abspath("").replace('projects', 'src')
sys.path.insert(0, tokenlab_path)

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

circ_supply = pd.read_csv('data/communitygame/circsupply.csv')['Circ_Supply'].values

revenues=pd.read_csv('data/communitygame/revenues.csv',index_col=0,header=None).T.reset_index(drop=True).fillna(0)
revenues = revenues.iloc[10:,:]

# Basic Parameters
INITIAL_PRICE = 0.05
SUPPLY = 1_000_000_000
NUM_USERS = 40495  # Initial number of users
MAX_USERS = 205000  # Maximum number of users

#extends the duratin of the simultion by fitting a model that follows the same user growth trajectory as the data given
EXTEND_SIM = 30

STAKING_REWARDS = 0.05
STAKING_AMOUNT = scipy.stats.uniform(50000,1_000_000)
STAKING_FEE=0
STAKING_QUIT_PROB = 0.05

ORG_FEES_DOLLAR = 0.1

BUY_ASSET_FEE = 0.01

TOURNAMENT_ORGS = 200
TOURNAMENT_MONTHLY_INCREASE = 5

ACTIVE_USERS_PROB=0.5

BASE_USER_GROWTH_ASSUMPTIONS=[40495.0,
 43329.0,
 46362.0,
 50071.0,
 52074.0,
 54157.0,
 56865.0,
 65395.0,
 71934.0,
 77689.0,
 89342.0,
 107210.0,
 128653.0,
 150523.0,
 176112.0,
 206052.0]

    
BASE_USER_GROWTH_ASSUMPTIONS  = extrapolate_to_length(BASE_USER_GROWTH_ASSUMPTIONS,60,p=2)

MAX_USERS = 10_000_000
    

sub_transactions = revenues['Subscription Revenue'].values.tolist()
sub_transactions =  extrapolate_to_length(sub_transactions,len(BASE_USER_GROWTH_ASSUMPTIONS),p=2)

marketplace_transactions = revenues['Marketplace Revenue'].values.tolist()
marketplace_transactions = extrapolate_to_length(marketplace_transactions,len(BASE_USER_GROWTH_ASSUMPTIONS),p=2)




ITERATIONS = len(BASE_USER_GROWTH_ASSUMPTIONS)

allocations = {
    'Seed - Series A': {'percentage': 0.25, 'vesting_period': 36, 'cliff': 12},  # 2 years vest, 6 months cliff
    'Team': {'percentage': 0.15, 'vesting_period': 24, 'cliff': 12*4},  # 3 years vest, 6 months cliff
    'Advisors': {'percentage': 0.02, 'vesting_period': 24, 'cliff': 4*12},  # 5 years vest, 6 months cliff
    'Liquidity': {'percentage': 0.03, 'vesting_period': 0, 'cliff': 0},  # 5 years vest, 6 months cliff
    'Rewards': {'percentage': 0.4, 'vesting_period': 12*5, 'cliff': 0}}

token_allocations = {category: SUPPLY * info['percentage'] for category, info in allocations.items()}
# Define vesting schedules
token_pools = []
for category, info in allocations.items():
    amount = token_allocations[category]
    vesting_period = info['vesting_period']
    cliff = info['cliff']
    pool = SupplyController_CliffVesting(amount, vesting_period, cliff)
    token_pools.append(pool)


total_allocated_percentage = sum(info['percentage'] for info in allocations.values())

total_allocated_percentage +=0.15
print('TOTAL ALLOCATED PERC: '+str(total_allocated_percentage))


# User Growth Simulation
user_growth_linear = UserGrowth_Spaced(initial_users=BASE_USER_GROWTH_ASSUMPTIONS[0], max_users=MAX_USERS, num_steps=ITERATIONS)
user_growth_logistic = UserGrowth_Spaced(initial_users=BASE_USER_GROWTH_ASSUMPTIONS[0], max_users=MAX_USERS, num_steps=ITERATIONS,
                                           space_function=logistic_saturated_space)


user_growth = user_growth_linear
user_growth_staking = UserGrowth_Spaced(initial_users=BASE_USER_GROWTH_ASSUMPTIONS[0], max_users=MAX_USERS, num_steps=ITERATIONS,
                                           space_function=logistic_saturated_space)

treasury_tokens = SUPPLY*0.15
treasury = TreasuryBasic(treasury={'$':100,'CG':treasury_tokens},name='treasury',conversion=('$','CG'))


# Transaction Data Generation
transactions_buy_assets = TransactionManagement_Assumptions(marketplace_transactions,ignore_num_users=True)
#transactions_sell_assets = TransactionManagement_Assumptions(transaction_values)
transactions_staking = TransactionManagement_Stochastic(value_per_transaction=10,transactions_per_user=1,activity_probs=ACTIVE_USERS_PROB)
# transactions_subscriptions = TransactionManagement_Assumptions(sub_transactions,ignore_num_users=True)
transactions_subscriptions = TransactionManagement_Stochastic(value_per_transaction=5,transactions_per_user=1,activity_probs=ACTIVE_USERS_PROB)

transactions_game_devs_to_treasury = TransactionManagement_TrendSimple(TOURNAMENT_ORGS,TOURNAMENT_MONTHLY_INCREASE)
transactions_org_grants = TransactionManagement_Constant(20000)



# Stochastic Holding Time for Agents
holding_time = HoldingTime_Stochastic()

# Create Agent Pool. When user controller is missing, then it's assumed that users=1
ap_buy_assets = AgentPool_Basic(transactions_controller=transactions_buy_assets, currency='$',treasury=treasury,name='buy',
                                fee=BUY_ASSET_FEE,fee_type='perc')

#ap_sell_assets = AgentPool_Basic(users_controller=user_growth, transactions_controller=transactions_sell_assets, currency='$',chained=True,name='sell')

ap_subscription_payments = AgentPool_Basic(users_controller=user_growth,transactions_controller=transactions_subscriptions, currency='$',
                                           chained=True,name='subs',activation_iteration=4)

ap_staking = AgentPool_Staking(users_controller=user_growth_staking,transactions_controller=transactions_staking,currency='CG',
                          staking_controller=SupplyStakerMonthly,staking_controller_params={'staking_amount':STAKING_AMOUNT,
                                                                                     'rewards':STAKING_REWARDS,'quit_prob':STAKING_QUIT_PROB},
                          name='stake',
                          treasury=treasury,fee=STAKING_FEE)

ap_game_developers_staking_fees = AgentPool_Basic(transactions_controller=transactions_game_devs_to_treasury, currency='$',
                                                  name='gamedevs_staking',fee=1,treasury=treasury)

ap_organiser_grants = AgentPool_Basic(transactions_controller=transactions_org_grants, currency='$',name='org_grants',
                                      fee=ORG_FEES_DOLLAR,treasury=treasury)




# Create and Configure Token Economy with Holding Time
te = TokenEconomy_Basic(
    supply=0, 
    initial_price=INITIAL_PRICE, 
    token='CG', 
    agent_pools=[ap_buy_assets,ap_subscription_payments,ap_organiser_grants,ap_staking,ap_game_developers_staking_fees],
    holding_time=holding_time,
    treasuries=[treasury],
    price_function = PriceFunction_LinearRegression,
    supply_is_added=True,
    supply_pools=token_pools,
    dynamic_price=False,
    multiple=2
)



# Run the Simulation
meta = TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS, repetitions=25)

# Extract and Plot Results
meta.get_timeseries('transactions_$')
token_price_timeseries = meta.get_timeseries('CG_price')
meta.get_timeseries('treasury_deposits_CG')
meta.get_timeseries('treasury_deposits_$')



te = TokenEconomy_Basic(
    supply=0, 
    initial_price=INITIAL_PRICE, 
    token='CG', 
    agent_pools=[ap_buy_assets,ap_subscription_payments,ap_organiser_grants,ap_staking,ap_game_developers_staking_fees],
    holding_time=holding_time,
    treasuries=[treasury],
    price_function = PriceFunction_LinearRegression,
    supply_is_added=True,
    supply_pools=token_pools,
    dynamic_price=False,
    multiple=1
)

meta_1 = TokenMetaSimulator(te)
meta_1.execute(iterations=ITERATIONS, repetitions=25)

token_price_timeseries_1 = meta_1.get_timeseries('CG_price')

prices = (token_price_timeseries[1].CG_price_mean - token_price_timeseries_1[1].CG_price_mean)/token_price_timeseries_1[1].CG_price_mean



# _,trans = meta.get_timeseries('transactions_$',plot=False)
# _,sup=meta.get_timeseries('supply',plot=False)
# joined=sup.join(trans,lsuffix='sup_')
# ax=joined.loc[:,['supply_mean','transactions_$_mean']].plot()
# ax.set_ylabel('value')

# plt.plot(BASE_USER_GROWTH_ASSUMPTIONS)
# plt.xlabel('month')
# plt.ylabel('num users')

# plt.plot(marketplace_transactions)
# plt.xlabel('month')
# plt.ylabel('transactions in $')


# plt.plot(sub_transactions)
# plt.xlabel('month')
# plt.ylabel('transactions in $')
