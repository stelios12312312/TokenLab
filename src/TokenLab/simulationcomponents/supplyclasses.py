#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Wed Nov 30 11:03:57 2022

@author: stylianoskampakis
"""

from typing import List, Dict,Union
from baseclasses import *
from utils.helpers import log_saturated_space
import scipy
from scipy import stats
from scipy.stats import uniform
import time
import copy

class SupplyController(Controller):

    
    def __init__(self):
        super(SupplyController,self).__init__()
        self.supply=None

    def get_supply(self)->float:
        
        return self.supply
    
    def execute(self)->float:
        
        pass
    
class SupplyController_Constant(SupplyController):
    def __init__(self,supply:float):
        super(SupplyController_Constant,self).__init__()
        self.supply=supply
        
        
        
class SupplyController_AdaptiveStochastic(SupplyController):
    """
    More advanced supply class for simulations. It assumes that at every iteration, some of tokens purchased
    are removed from circulation, and then a random % of them returns in the next iteration.
    """
    
    def __init__(self,supply:float,
                 removal_distribution:scipy.stats=uniform,removal_dist_parameters={'loc':0,'scale':0.1},
                 addition_distribution:scipy.stats=uniform,addition_dist_parameters={'loc':0,'scale':0.05}
                 ):
        self.dependencies={TokenEconomy:None}
        self.inactive_tokens=0
        
        self._removal_distribution=removal_distribution
        self._removal_dist_parameters=removal_dist_parameters
        
        self._addition_distribution=addition_distribution
        self._addition_dist_parameters=addition_dist_parameters
        
        self.supply=supply
        
        
    def execute(self)->None:
        tokeneconomy=self.dependencies[TokenEconomy]
        purchases_in_tokens=tokeneconomy.transactions_volume_in_tokens*tokeneconomy.holding_time
        
        seed=int(int(time.time())*np.random.rand())
        percentage_removal=self._removal_distribution.rvs(size=1,**self._removal_dist_parameters,random_state=seed)[0]
        token_removal=purchases_in_tokens*percentage_removal
        
        self.inactive_tokens+=token_removal

        
        percentage_addition=self._addition_distribution.rvs(size=1,**self._addition_dist_parameters,random_state=seed)[0]
        tokens_coming_back=self.inactive_tokens*percentage_addition
        new_supply = self.supply + tokens_coming_back - token_removal
        
        if new_supply<=0:
            new_supply=self.supply + tokens_coming_back
        self.supply=new_supply
        
        
        
class SupplyController_InvestorDumperSpaced(SupplyController):
    """
    Simulates an investor pool that is just dumping the coin in a predictable fashion. Supports noise addons.
    """
    
    def __init__(self,dumping_initial:float,dumping_final:float,num_steps:int,
                 space_function:Union[np.linspace,np.logspace,np.geomspace,log_saturated_space]=np.linspace,name:str=None,
                 noise_addon:AddOn=None):
        super(SupplyController_InvestorDumperSpaced,self).__init__()

        self.num_steps=num_steps
        self.space_function=space_function
        self._noise_component=noise_addon
        
        self.name=name
        
        self._dumping_store_original=np.round(self.space_function(start=dumping_initial,stop=dumping_final,num=num_steps)).astype(int)
        self._dumping_store=copy.deepcopy(self._dumping_store_original)
        
        #applies the noise addon. If a value is below 0, then it is kept at 0.
        if self._noise_component!=None:
            dummy=[]
            for i in range(len(self._dumping_store)):
                temporary= self._dumping_store_original[i]+ self._noise_component.apply(**{'value':self._dumping_store_original[i]})
                if temporary>=0:
                    dummy.append(temporary)
                else:
                    dummy.append(self._dumping_store_original[i])
        
            self._dumping_store=dummy
        
        self._dumped_tokens_store=[]
        self.max_iterations=num_steps
        self.iteration=0
        
            
    def execute(self)->float:
        
        self.dumping_number=self._dumping_store[self.iteration]
        
        self._dumped_tokens_store.append(self.dumping_number)
        
        self.supply=self.dumping_number
        
        self.iteration+=1
        return self.dumping_number  
        
    
        
        