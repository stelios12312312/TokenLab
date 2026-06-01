#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Mar 15 09:50:16 2024

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
ITERATIONS = 5*12
INITIAL_PRICE = 0.00006
#MAX_USERS = 5_000_000  # Maximum number of users


number_strings = [
    "19,045,000", "25,230,556", "31,416,111", "37,601,667", "43,787,222", "49,972,778",
    "102,550,000", "119,723,056", "136,896,111", "154,069,167", "171,242,222", "188,415,278",
    "205,588,333", "226,830,833", "248,073,333", "269,315,833", "290,558,333", "311,800,833",
    "333,043,333", "346,553,889", "360,064,444", "373,575,000", "387,085,556", "400,596,111",
    "414,106,667", "427,617,222", "441,127,778", "454,638,333", "468,148,889", "481,659,444",
    "495,170,000", "507,052,778", "518,935,556", "530,818,333", "542,701,111", "554,583,889",
    "566,466,667", "569,722,222", "572,977,778", "576,233,333", "579,488,889", "582,744,444",
    "586,000,000", "586,000,000", "586,000,000", "586,000,000", "586,000,000", "586,000,000",
    "586,000,000", "586,000,000", "586,000,000", "586,000,000", "586,000,000", "586,000,000",
    "586,000,000", "586,000,000", "586,000,000", "586,000,000", "586,000,000", "586,000,000"
]

# Convert the list of string numbers into integers after removing commas
SUPPLYS = [int(num.replace(",", "")) for num in number_strings]


SUPPLY = SupplyController_FromData(SUPPLYS)

STARTING_VOLUME = 100_000
FINAL_VOLUME = 4_000_000

user_growth = UserGrowth_Constant(1)
transactions = TransactionManagement_Trend(average_transaction_initial=STARTING_VOLUME,  
                                           # space_function=log_saturated_space,
                                           average_transaction_final=FINAL_VOLUME,
                                           num_steps=ITERATIONS,
                                           noise_addons = [
                                                AddOn_MultiplierTimed(0.5,[0,60])
                                               ]
                                           )

holding_time = HoldingTime_Stochastic()

# Create Agent Pools using the user growth object
ap_fiat = AgentPool_Basic(users_controller=user_growth, transactions_controller=transactions, currency='$')


te = TokenEconomy_Basic(
    holding_time=holding_time, 
    supply=SUPPLY, 
    token='Evai', 
    initial_price=INITIAL_PRICE,
    price_function=PriceFunction_LinearRegression, 
    burn_token=False,
    burn_coefficient=0.00,
    supply_is_added=False,
    multiple=1.0
)

# Add the agent pool to the token economy
# te.add_agent_pools([ap_fiat, ap_fiat_new])
te.add_agent_pool(ap_fiat)

# Run the Simulation
meta = TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS, repetitions=100)

# Extract Simulation Data
reps = meta.get_data()

# Extract Token Price Data
_,token_price_timeseries = meta.get_timeseries('Evai_price',multiple=50)
