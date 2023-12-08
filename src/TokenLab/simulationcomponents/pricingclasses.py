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
from baseclasses import Controller,TokenEconomy,AddOn
import pandas as pd
from tqdm import tqdm
from matplotlib import pyplot as plt
import time
from addons import AddOn_RandomNoise, AddOn_RandomNoiseProportional



class HoldingTimeController(Controller):
    """
    Abstract class from which all HoldingTime controllers should inherit.
    """
    
    def __init__(self):
        super(HoldingTimeController,self).__init__()
        self.holding_time=None

    
    def get_holding_time(self)->float:
        return self.holding_time
    
    def execute(self)->float:
        
        pass
    
    
class HoldingTime_Constant(HoldingTimeController):
    """
    Constant holding time
    """
    
    def __init__(self,holding_time:float):
        """
        

        Parameters
        ----------
        holding_time : float
            The holding time. Needs to be positive.

        Raises
        ------
        Exception
            If holding_time<0 then raise Exception.

        Returns
        -------
        None.

        """
        super(HoldingTime_Constant,self).__init__()

        if holding_time<=0:
            raise Exception('Holding time needs to be a positive real value!')
        self.holding_time=holding_time

class HoldingTime_Stochastic(HoldingTimeController):
    """
    Uses a probability distribution and samples a random holding time per iteration.
    """
    
    def __init__(self,distribution:scipy.stats=scipy.stats.lognorm,holding_time_params:Union[Dict[str,float],List[Dict[str,float]]]={'loc':0,'s':1},
                 minimum:float=0.1):
        """
        

        Parameters
        ----------
        holding_time_dist : scipy.stats, optional
           A scipy distribution to sample the holding time from. The default is scipy.stats.halfnorm.
        holding_time_params : Dict, optional
            The parameters of the distribution. The default is {'loc':0,'scale':1}.
        minimum : float, optional
            The minimum possible holding time. If the sampled holding time is <1, then it reverts to minimum. The default is 0.1.

        Returns
        -------
        None.

        """
        super(HoldingTime_Stochastic,self).__init__()

        self.distribution=distribution
        self.dist_params=holding_time_params
        self.minimum=minimum
        self.execute()
        
        
    def execute(self)->float:
        """
        

        Returns
        -------
        float
            The holding time.

        """
        seed=int(int(time.time())*np.random.rand())
        
        if type(self.dist_params)==type([]):
            #if the end of the iteration has been reached simply use the last one
            try:
                parameters=self.dist_params[self.iteration]
            except:
                parameters=self.dist_params[-1]
        else:
            parameters=self.dist_params


        self.holding_time=self.distribution.rvs(size=1,**parameters,random_state=seed)[0]
        if self.holding_time<self.minimum:
            self.holding_time=self.minimum
            
        self.iteration+=1

        
        return self.holding_time
    
    
    def sample(self)->List:
        """
        Samples datapoints to plot them
        """
        
        datapoints = self.distribution.rvs(size=1000,**self.dist_params)        

        
        return datapoints
    
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
    """
    Abstract class for price controllers.
    
    """
        
    
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
    
    def __init__(self,noise_addon:AddOn=None,smoothing_param:float=1,use_velocity:bool=True):
        """
        
        Parameters
        ----------
        
        noise_AddOn: Optional, if this is used, then the noise is added to the price.
        If the price is negative, then the noise add-on is ignored, and the returned price
        is the price without the noise.
        
        smoothing_param: Float. If set below 1, then this applied a weighted average between the new price
        and the old price. This causes an anchoring effect, since in practice the new price would 
        be anchored to some extent to the previous one. A smoothing_param of 0.9, for exaple
        calculates the final price as 0.9*newprice+0.1*old_price
        """
        super(PriceFunction_EOE,self).__init__()
        self._noise_addon=noise_addon
        self.use_velocity = use_velocity
        
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
        
        if self.use_velocity:
            velocity = 0.03358 + 1.20329 * 1/holding_time

            
            if velocity<0:
                velocity=0.01
            
            price_new=transaction_volume_in_fiat/(supply_of_tokens*velocity)
        else:
            price_new=holding_time*transaction_volume_in_fiat/supply_of_tokens
            
                

        #noise adjustment
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
        
class PriceFunction_BondingCurve(PriceFunctionController):
    """
    
    Implements pricing based upon bonding curves.
    
    The bonding curve is always a function of supply.
    """
    
    def __init__(self,function:Callable,max_supply:float=np.inf):
                         
        super(PriceFunction_BondingCurve,self).__init__()
        self._bonding_function = function
        self._max_supply = max_supply
        
    def execute(self)->float:
        tokeneconomy=self.dependencies[TokenEconomy]
        supply_of_tokens = tokeneconomy.transactions_volume_in_tokens
        
        if supply_of_tokens + tokeneconomy.supply > self._max_supply:
            supply_of_tokens = self._max_supply - tokeneconomy.supply
                
        tokeneconomy.supply += supply_of_tokens
        
        price_new = self._bonding_function(tokeneconomy.supply)
        
        self.price = price_new
        
        self.iteration+=1
        
        
class PriceFunction_IssuanceCurve(PriceFunctionController):
    """
    
    Implements pricing based upon bonding curves.
    
    The difference between the boding curve and the issuance curve, is that the 
    issuance curve takes into account all the tokens that have ever entered circulation.
    
    The bonding curve takes into account only the tokens that are now in the main token economy.
    
    """
    
    def __init__(self,function:Callable,keep_internal_supply_state:bool=True,
                 max_supply:float=np.inf):
        """
        

        Parameters
        ----------
        function : Callable
            The bonding curve function.

        Returns
        -------
        None.

        """
        
        super(PriceFunction_IssuanceCurve,self).__init__()
        self._bonding_function = function
        self._tokens_ever_issued = 0
        self._max_supply = max_supply
        
    def execute(self)->float:
        tokeneconomy=self.dependencies[TokenEconomy]
        supply_of_tokens = tokeneconomy.transactions_volume_in_tokens
        
        new_supply = tokeneconomy.supply + supply_of_tokens
        if new_supply>self._max_supply:
            new_supply = self._max_supply - tokeneconomy.supply
            
            
        tokeneconomy.supply += new_supply
        
        self._tokens_ever_issued += new_supply
        
        price_new = self._bonding_function(self._tokens_ever_issued)
        
        self.price = price_new
        
        self.iteration+=1
        
        
class PriceFunction_LinearRegression(PriceFunctionController):
    
    """
    Implements a pricing function based upon the research by Kampakis and Melody
    """
        
    
    def __init__(self,top_appreciation:float=0.3,std_prior:float=0.1,anchoring:float=0.1,proportionate_noise=True):
        """
        

        Parameters
        ----------
        top_appreciation : float, optional
            If the price appreciates by more than top_appreciation%, then cap the appreciation. The default is 0.3.
        std_prior : float, optional
            This is used in the calculation of the price if stochastic=True. The default is 0.1.
            
            The way this is used is that it sets the variance of the prediction interval (t-distribution)
            equal to std_prior*previous_price. Hence the variance increases as the price increases.
            This relationship has been confirmed through empirical data, but the exact prior requires
            further validation.

        Returns
        -------
        None.

        """
        
        super(PriceFunction_LinearRegression,self).__init__()
        
        self.top_appreciation = top_appreciation
        self.std_prior = std_prior
        self.anchoring=anchoring
        self.proportionate_noise=proportionate_noise
        
    
    def execute(self)->float:
        tokeneconomy=self.dependencies[TokenEconomy]
        H = tokeneconomy.holding_time
        
        # V = 0.69049 - 0.32288 * np.log(H) + 0.04242 * np.log(H)**2
        V = 0.03358 + 1.20329 * 1/H	
        
        if V<0:
            V = 0.001
            
        # print(V)
                    
        T = tokeneconomy.transactions_value_in_fiat
        M = tokeneconomy.supply
        previous_price = tokeneconomy.price
        
        # log_price_new = -0.08506 + 0.00139 * np.log(T) - 0.00481 * np.log(1/M) + 0.00059 * np.log(1/V) \
          #  +0.99644 * np.log(previous_price)
          
        log_price_new = 0.88 * np.log(T) + 0.84* np.log(1/M) + 1.15 * np.log(1/V)
            
        if self.proportionate_noise:
            sample = log_price_new+scipy.stats.t(13000).rvs(1)*self.std_prior*previous_price
        else:
            sample = log_price_new+scipy.stats.t(13000).rvs(1)*self.std_prior

        price_new = (1-self.anchoring)*np.exp(sample[0]) + self.anchoring*previous_price
            
        if price_new<=0:
            price_new = 0.0001
            
        if price_new>tokeneconomy.price*(1+self.top_appreciation):
            price_new = tokeneconomy.price*(1+self.top_appreciation)


        self.price = price_new        
        self.iteration+=1


        
