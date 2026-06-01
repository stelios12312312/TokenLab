import numpy as np
import scipy.stats
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
import math

def reward_function(S, iterations, a=0.25, b=0.001):
    def f(S, a):
        #we turn it to absolute because inside the computations we use negative staking so we reduce supply
        S=np.abs(S)
        return math.log10(a * S + 10)
    
    # Generate T from a uniform distribution between 100,000 and 2,000,000
    T = np.random.uniform(100_000, 2_000_000)
    
    # Convert iterations to weeks
    W = iterations // 4  # Assuming 4 iterations per month
    rewards = (b * T * f(S, a)) / (W + 1)  # Adding 1 to W to avoid division by zero
    return rewards

numbers = [
    21000000,
    48972222,
    76944444,
    104916667,
    132888889,
    160861111,
    188833333,
    220972222,
    253111111,
    285250000,
    317388889,
    349527778,
    381666667,
    393055556,
    404444444,
    415833333,
    427222222,
    438611111,
    450000000,
    454166667,
    458333333,
    462500000,
    466666667,
    470833333,
    475000000,
    479166667,
    483333333,
    487500000,
    491666667,
    495833333,
    500000000
] + [500_000_000] * 29







# Basic Parameters
ITERATIONS = 60
INITIAL_PRICE = 0.001
SUPPLY = SupplyController_FromData(numbers) 
FEE = 0.00001

STARTING_VOLUME = 1_000_000
FINAL_VOLUME = 1_000_00

def generate_number_sequence(start_value, end_value, crash_percent, recovery_rate, total_length):
    # Generate the first part of the sequence (increasing values)
    first_half_length = total_length // 2
    first_half = np.linspace(start_value, end_value, first_half_length).tolist()
    
    # Calculate the value after the crash
    crash_value = first_half[-1] * (1 - crash_percent / 100)
    
    # Generate the recovery part of the sequence
    second_half_length = total_length - first_half_length
    recovery_values = [crash_value]
    for _ in range(second_half_length - 1):
        next_value = recovery_values[-1] * (1 + recovery_rate / 100)
        recovery_values.append(next_value)
    
    # Combine the two parts to form the final sequence
    final_sequence = first_half + recovery_values
    return final_sequence

# Parameters
start_value = 10000
end_value = 1000000
crash_percent = 70  # 50% crash
recovery_rate = 1   # 5% per month recovery
total_length = 60

# Generate the sequence
TRANSACTIONS = generate_number_sequence(start_value, end_value, crash_percent, recovery_rate, total_length)



user_growth = UserGrowth_Constant(1)
transactions = TransactionManagement_Trend(average_transaction_initial=STARTING_VOLUME,  
                                           space_function=log_saturated_space,
                                           average_transaction_final=FINAL_VOLUME,
                                           num_steps=ITERATIONS)

transactions = TransactionManagement_FromData(TRANSACTIONS)

holding_time = HoldingTime_Stochastic()

# Define staking controller parameters
staking_controller_params = {
    'staking_amount': scipy.stats.uniform(10_000, 240_000),  # Uniform distribution from 10,000 to 250,000
    'reward_function': reward_function,
    'reward_as_perc': True,  # Example parameter
    'quit_prob': 0.1,  # Example parameter
    'name': 'rewards'
}

# Create Agent Pools using the user growth object
ap_fiat = AgentPool_Staking(#users_controller=user_growth, 
                            transactions_controller=transactions, 
                            staking_controller=SupplyStakerMonthly_Callable,
                            staking_controller_params=staking_controller_params,
                            currency='$')




te = TokenEconomy_Basic(
    holding_time=holding_time, 
    supply=SUPPLY, 
    token='Fido', 
    initial_price=INITIAL_PRICE,
    price_function=PriceFunction_LinearRegression, 
    burn_token=False,
    burn_coefficient=0.00,
    supply_is_added=False
)

# Add the agent pool to the token economy
# te.add_agent_pools([ap_fiat, ap_fiat_new])
te.add_agent_pool(ap_fiat)

# Run the Simulation
meta = TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS, repetitions=50)

meta.get_valid_cols()
# Extract Simulation Data
reps = meta.get_data()

# Extract Token Price Data
_,token_price_timeseries = meta.get_timeseries('Fido_price',multiple=10)
_,transactions = meta.get_timeseries('transactions_$')
_,supply_timeseries = meta.get_timeseries('supply')
_,rewards = meta.get_timeseries('supply_rewards_value')
_,rew_number = meta.get_timeseries('supply_rewards_number_total')


