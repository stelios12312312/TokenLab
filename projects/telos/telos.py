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
from TokenLab.simulationcomponents.addons import *
from TokenLab.utils.helpers import *

# Basic Parameters
ITERATIONS = 60
INITIAL_PRICE = 0.05
SUPPLY = 100_000_0000  # Total token supply for pools
NUM_USERS = 1_000  # Initial number of users
MAX_USERS = 5_000_000  # Maximum number of users
FEE = 0.0001

treasury = TreasuryBasic(treasury={'Token':100},name='treasury')

# Define the cliff period (in iterations, assuming monthly)
CLIFF_PERIOD = 3  # months

# Define the allocation percentages, vesting periods, and cliff periods (in iterations, assuming monthly)
# allocations = {
#     'Funding': {'percentage': 0.20, 'vesting_period': 24, 'cliff': CLIFF_PERIOD,'delay':0},  # 2 years vest, 6 months cliff
#     'Telos Foundation': {'percentage': 0.20, 'vesting_period': 36, 'cliff': 0,'delay':0},  # 3 years vest, 6 months cliff
#     'User incentives': {'percentage': 0.20, 'vesting_period': 60, 'cliff': CLIFF_PERIOD,'delay':0},  # 5 years vest, 6 months cliff
#     'Marketing': {'percentage': 0.10, 'vesting_period': 60, 'cliff': CLIFF_PERIOD,'delay':0},  # 5 years vest, 6 months cliff
#     'Airdrop': {'percentage': 0.10, 'vesting_period': 12, 'cliff': CLIFF_PERIOD,'delay':0},  # 1 year vest, 6 months cliff
#     'Grant programme': {'percentage': 0.20, 'vesting_period': 36, 'cliff': CLIFF_PERIOD,'delay':0},  # 3 years vest, 6 months cliff
# }

allocations = {
    'Funding': {'percentage': 0.20, 'vesting_period': 18, 'cliff': CLIFF_PERIOD,'delay':12},  
    'Telos Foundation': {'percentage': 0.20, 'vesting_period': 48, 'cliff': 0,'delay':12},  
    'User incentives': {'percentage': 0.20, 'vesting_period': 12*10, 'cliff': CLIFF_PERIOD,'delay':0},  
    'Liquidity': {'percentage': 0.10, 'vesting_period': 3, 'cliff': 0,'delay':0},  
    'Airdrop': {'percentage': 0.10, 'vesting_period': 6, 'cliff': 0,'delay':0},  
    'Grant programme': {'percentage': 0.20, 'vesting_period': 12*10, 'cliff': CLIFF_PERIOD,'delay':3},  
}

# Assuming SUPPLY is defined somewhere above in the code
# SUPPLY = 1000000  # Define the total supply of tokens

# Calculate the token allocation for each category
token_allocations = {category: SUPPLY * info['percentage'] for category, info in allocations.items()}

# Calculate the total allocated percentage
total_allocated_percentage = sum(info['percentage'] for info in allocations.values())

# Calculate the remaining percentage
remaining_percentage = 1 - total_allocated_percentage

# Calculate the remaining supply
remaining_supply = SUPPLY * remaining_percentage


# Define vesting schedules
token_pools = []
all_supply=0
for category, info in allocations.items():
    amount = token_allocations[category]
    vesting_period = info['vesting_period']
    cliff = info['cliff']
    delay = info['delay']
    pool = SupplyController_CliffVesting(amount, vesting_period, cliff,name=category,delay=delay)
    token_pools.append(pool)
    all_supply+=sum(pool._data)
    

# token_pools now contains SupplyController_CliffVesting objects for each category with the respective cliff and vesting periods


#Digital collectibles
# List for Unique Active Wallets (UAW)
uaw_list = [50, 250, 500, 1000, 2000, 3000, 4000, 5000, 7500, 12500, 17500, 25000]
uaw_list= extrapolate_to_length(uaw_list,ITERATIONS,p=4)

transactions_daily_list = [1350, 6750, 13500, 27000, 54000, 81000, 108000, 135000, 202500, 337500, 472500, 675000]
transactions_daily_list= extrapolate_to_length(transactions_daily_list,ITERATIONS,p=4)

ap_collectibles = AgentPool_Basic(users_controller=uaw_list,transactions_controller=transactions_daily_list,currency='$',
                                  treasury=treasury,fee_type='fixed',fee=FEE)



# List for Unique Active Wallets (UAW)
uaw_list = [50, 250, 500, 1000, 2000, 3000, 4000, 5000, 7500, 12500, 17500, 25000]
uaw_list= extrapolate_to_length(uaw_list,ITERATIONS,p=4)

# List for Dollar Amounts
dollar_amount_list = [500, 2500, 5000, 10000, 20000, 30000, 40000, 50000, 75000, 125000, 175000, 250000]
dollar_amount_list= extrapolate_to_length(dollar_amount_list,ITERATIONS,p=4)

ap_pass= AgentPool_Basic(users_controller=uaw_list,transactions_controller=dollar_amount_list,currency='$',
                                  treasury=treasury,fee_type='fixed',fee=FEE)


# User Growth
user_growth = UserGrowth_Spaced(initial_users=NUM_USERS, max_users=MAX_USERS, num_steps=ITERATIONS,
                                noise_addons=[AddOn_RandomNoiseProportional(),
                                              AddOn_RandomReduction(reduction_dist=scipy.stats.uniform(loc=0, scale=0.2))])

# Transaction Data
transactions = TransactionManagement_Stochastic(value_distribution=scipy.stats.norm,
                                                value_dist_parameters={'loc':5,'scale':5},
                                                transactions_distribution=poisson,
                                                transactions_dist_parameters={'mu':1},type_transaction='positive'
                                                )


# Agent Pool
ap_fiat = AgentPool_Basic(users_controller=user_growth, transactions_controller=transactions, currency='$',treasury=treasury,
                          fee_type='fixed',fee=FEE)





sell_pressure = TransactionManagement_MarketcapStochastic(sign='negative',distribution_params = {'loc':0,'scale':0.25})

ap_sell_pressure = AgentPool_Basic(transactions_controller = sell_pressure,currency='Token')

# Token Economy
te = TokenEconomy_Basic(
    supply=remaining_supply,
    initial_price=INITIAL_PRICE,
    token='Token',
    holding_time=HoldingTime_Stochastic(),
    agent_pools=[ap_fiat,ap_sell_pressure,ap_collectibles,ap_pass],
    supply_pools=token_pools,
    price_function=PriceFunction_LinearRegression,
    supply_is_added=True,
    max_supply=SUPPLY
)

# Running the Simulation
meta = TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS, repetitions=50)

# Extract Token Price Timeseries
trans_timeseries = meta.get_timeseries('transactions_$')
tres = meta.get_timeseries('treasury_deposits_$')
meta.get_timeseries('num_users')

sup=meta.get_timeseries('supply')
token_price_timeseries = meta.get_timeseries('Token_price')




plt.hist(scipy.stats.poisson(1).rvs(1000))
plt.xlabel('distribution of num transactions per month for a typical user')


# plt.plot(user_growth.get_users_store())
# plt.xlabel('month')
# plt.ylabel('users')


# plt.hist(HoldingTime_Stochastic().sample())
# plt.xlabel('months')

plt.hist(np.abs(scipy.stats.norm(**{'loc':5,'scale':1}).rvs(2000)))
plt.xlabel('Average transaction per user in $')
