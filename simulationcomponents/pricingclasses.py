#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Wed Nov 23 11:54:33 2022

@author: stylianoskampakis
"""

import numpy as np
import scipy
from scipy.stats import binom,norm
from typing import Union,TypeVar,Callable
from typing import List, Dict,Union,Tuple
from .baseclasses import Controller,TokenEconomy,AddOn
import pandas as pd
from tqdm import tqdm
from matplotlib import pyplot as plt
import time
from .addons import AddOn_RandomNoise, AddOn_RandomNoiseProportional


class HoldingTimeController(Controller):
    
    def __init__(self):
        super(HoldingTimeController,self).__init__()
        self.holding_time=None

    
    def get_holding_time(self)->float:
        return self.holding_time
    
    def execute(self)->float:
        
        pass
    
    
class HoldingTime_Constant(HoldingTimeController):
    
    
    def __init__(self,holding_time):
        super(HoldingTime_Constant,self).__init__()

        if holding_time<=0:
            raise Exception('Holding time needs to be a positive real value!')
        self.holding_time=holding_time

class HoldingTime_Stochastic(HoldingTimeController):
    """
    Uses a probability distribution and samples a random holding time per iteration.
    """
    
    def __init__(self,holding_time_dist:scipy.stats=scipy.stats.halfnorm,holding_time_params:Dict={'loc':0,'scale':1},
                 minimum:float=0.1):
        self.distribution=holding_time_dist
        self.dist_params=holding_time_params
        self.minimum=minimum
        self.execute()
        
        
    def execute(self)->float:
        seed=int(int(time.time())*np.random.rand())

        self.holding_time=self.distribution.rvs(size=1,**self.dist_params,random_state=seed)[0]
        if self.holding_time<self.minimum:
            self.holding_time=self.minimum
        
        return self.holding_time
    
class HoldingTime_Adaptive(HoldingTimeController):
    
    """
    Recalculates holding time based on transaction volume and price.
    
    It includes minimum and maximum values. If these are not set, then the calculations can get out of hand
    into unrealistic values. The maximum value of 12 is set based on the assumption that the unit of time is a month.
    Hence, the maximum holding time (by default) is set to 1 year.
    
    """
    def __init__(self,holding_time,noise_addon:AddOn=None,minimum:float=0.01,maximum:float=12):
        self.dependencies={TokenEconomy:None}
        super(HoldingTime_Adaptive,self).__init__()

        if holding_time<=0:
            raise Exception('Holding time needs to be a positive real value!')
        self.holding_time=holding_time
        self._noise_addon=noise_addon
        self.minimum=minimum
        self.maximum=maximum
        
        
    def execute(self)->float:
        tokeneconomy=self.dependencies[TokenEconomy]
        
        holding_time=tokeneconomy.price*tokeneconomy.transactions_volume_in_tokens/(tokeneconomy.transactions_value_in_fiat++0.000000001)
        
        if self._noise_addon!=None:
            dummy=self._noise_addon.apply(**{'value':price_new})

            if dummy+holding_time>0:
                holding_time=dummy+holding_time
        if holding_time<self.minimum:
            holding_time=self.minimum
        elif holding_time>self.maximum:
            holding_time=self.maximum
        
        self.holding_time=holding_time
        
        
class PriceFunctionController(Controller):
        
    
    def __init__(self):
       super(PriceFunctionController,self).__init__()
       self.dependencies={TokenEconomy:None}
       self.price=None
    
    def execute(self)->float:
        iteration+=1
        pass
    
    def get_price(self)->float:
        
        return self.price
    
    
    
    
class PriceFunction_EOE(PriceFunctionController):
    """
    Simple implementation of equation of exchange. Can also implement noise through AddOns.
    
    If the AddOns make the price go negative, then the price goes back to simple equation of exchange before 
    noise w as added.
    """
    
    def __init__(self,noise_addon:AddOn=None,smoothing_param:float=1):
        """
        smoothing_param: If set below 1, then this applied a weighted average between the new price
        and the old price. This causes an anchoring effect, since in practice the new price would 
        be anchored to some extent to the previous one. A smoothing_param of 0.9, for exaple
        calculates the final price as 0.9*newprice+0.1*old_price
        """
        super(PriceFunction_EOE,self).__init__()
        self._noise_addon=noise_addon
        
        if smoothing_param>1 or smoothing_param<0:
            raise Exception('Smoothing param must be in [0,1]')
        else:
            self.smoothing_param=smoothing_param
    
    def execute(self)->float:  
        tokeneconomy=self.dependencies[TokenEconomy]
        
        transaction_volume_in_fiat=tokeneconomy.transactions_value_in_fiat
        holding_time=tokeneconomy.holding_time
        #supply_of_tokens=tokeneconomy.transactions_value_in_tokens
        supply_of_tokens=tokeneconomy.supply
        
        # if token==None:
        # #price=tokeneconomy.price
        #     transaction_volume_in_fiat=tokeneconomy.transactions_value_in_fiat
        #     holding_time=tokeneconomy.holding_time
        #     supply_of_tokens=tokeneconomy.supply
        # else:
        #     transaction_volume_in_fiat=tokeneconomy.transactions_value_in_fiat[token]
        #     holding_time=tokeneconomy.holding_time
        #     supply_of_tokens=tokeneconomy.supply[token]
                

        #noise adjustment
        price_new=holding_time*transaction_volume_in_fiat/supply_of_tokens
        
        price_new=self.smoothing_param*price_new+(1-self.smoothing_param)*tokeneconomy.price
        
        if self._noise_addon!=None:
            price_new_2=self._noise_addon.apply(**{'value':price_new})
        else:
            price_new_2 = -1
            
        if price_new_2<0:
            self.price=price_new
        else:
            self.price=price_new_2
        
        self.iteration+=1
        
#
        

# class PriceFunction_EOE_Noise(PriceFunctionController):
#     """
#     Implementation of the equation of exchange, plus a noise component.
    
#     If the noise drives the price below 0, then the price remains unchanged.
#     """
    
#     def __init__(self,noise_dist:scipy.stats=scipy.stats.norm,
#                  dist_params:Dict={'loc':0,'scale':1}):
#         super(PriceFunction_EOE_Noise,self).__init__()
#         self.noise_dist=noise_dist
#         self.dist_params=dist_params
    
#     def execute(self)->float:  
#         tokeneconomy=self.dependencies[TokenEconomy]
        
#         #price=tokeneconomy.price
#         transaction_volume_in_fiat=tokeneconomy.transactions_value_in_fiat
#         holding_time=tokeneconomy.holding_time
#         supply_of_tokens=tokeneconomy.supply
                
#         seed=int(int(time.time())*np.random.rand())
#         noise=self.noise_dist.rvs(size=1,**self.dist_params,random_state=seed)[0]
#         new_price=holding_time*transaction_volume_in_fiat/supply_of_tokens+noise
#         if new_price<0:
#             new_price=holding_time*transaction_volume_in_fiat/supply_of_tokens
#         self.price=new_price
#         self.iteration+=1
        
# class PriceFunction_EOE_AdaptiveNoise(PriceFunctionController):
#     """
#     Implementation of the equation of exchange, plus an adaptive noise component.
    
#     Uses normal error, but the variance changes dependi ng on the price level.
    
#     More specifically, the noise is defined as Normal(mean_param,price/std_param).
    
#     If the new price is below 0, then we simply remove the noise component for that iteration.
#     """
    
#     def __init__(self,noise_dist:scipy.stats=scipy.stats.norm,
#                  mean_param=0,std_divider=3):
#         super(PriceFunction_EOE_AdaptiveNoise,self).__init__()
#         self.mean_param=mean_param
#         self.std_divider=std_divider
#         self.noise_dist=noise_dist
    
#     def execute(self)->float:  
#         tokeneconomy=self.dependencies[TokenEconomy]
        
#         previous_price=tokeneconomy.price
#         transaction_volume_in_fiat=tokeneconomy.transactions_value_in_fiat
#         holding_time=tokeneconomy.holding_time
#         supply_of_tokens=tokeneconomy.supply
                
#         seed=int(int(time.time())*np.random.rand())
#         noise=self.noise_dist.rvs(size=1,loc=self.mean_param,scale=previous_price/self.std_divider,random_state=seed)[0]
        
#         new_price=holding_time*transaction_volume_in_fiat/supply_of_tokens+noise
#         if new_price<0:
#             new_price=holding_time*transaction_volume_in_fiat/supply_of_tokens
#         self.price=new_price
#         self.iteration+=1