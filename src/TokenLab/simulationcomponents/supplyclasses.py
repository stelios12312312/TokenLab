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
    """
    Base class for other supply controllers.
    """

    
    def __init__(self):
        super(SupplyController,self).__init__()
        self.supply=None

    def get_supply(self)->float:
        
        return self.supply
    
    def execute(self)->float:
        
        pass
    
class SupplyController_Constant(SupplyController):
    """
    Most basic type of supply controller. Supply is simply constant 
    and doesn't change.
    """
    def __init__(self,supply:float):
        """
        

        Parameters
        ----------
        supply : float
            The total supply.

        Returns
        -------
        None.

        """
        super(SupplyController_Constant,self).__init__()
        self.supply=supply
        
        
        
class SupplyController_AdaptiveStochastic(SupplyController):
    """
    More advanced supply class for simulations. It assumes that at every iteration, some of tokens purchased
    are removed from circulation, and then a random % of them returns in the next iteration.
    
    Therefore, this class simulates total supply, but also circulating supply.
    
    This supply controller attaches itself to a TokenEconomy and reads from there directly
    the transaction volume, the price and the holding time.
    """
    
    def __init__(self,
                 removal_distribution:scipy.stats=uniform,removal_dist_parameters={'loc':0,'scale':0.1},
                 addition_distribution:scipy.stats=uniform,addition_dist_parameters={'loc':0,'scale':0.05},
                 return_negative=True
                 ):
        """
        

        Parameters
        ----------
        removal_distribution : scipy.stats, optional
             A scipy.stats distribution that determines how much % of the supply is removed and held off the market
             at each iteration. The distribution must return numbers only in the range [0,1] or a subset of this range. 
             This is used to simulate holders who are removing liquidity from the market. The default distribution is uniform.
        removal_dist_parameters : Parameters for the removal distribution, optional
            DESCRIPTION. The default is {'loc':0,'scale':0.1}.
        addition_distribution : This performs the inverse function of the removal distribution. It simply takes
        some of the assets removed, and gets them back in ciruculation.. scipy.stats, optional
            . The default is uniform.
        addition_dist_parameters : TYPE, optional
            Parameters for the addition distribution. The default is {'loc':0,'scale':0.05}.
        return_negative: If True, then the execute() function can return a negative number. This is interpreted 
        as removing from the supply.

        Returns
        -------
        None.

        """
    

        self.dependencies={TokenEconomy:None}
        self.inactive_tokens=0
        
        self._removal_distribution=removal_distribution
        self._removal_dist_parameters=removal_dist_parameters
        
        self._addition_distribution=addition_distribution
        self._addition_dist_parameters=addition_dist_parameters
                
        self.return_negative=return_negative
        self.supply=0
        
        
    def execute(self)->None:
        """
        
        The function works as follows
        
        1. Read from the token economy the total purchases of tokens
        2. Calculate the tokens that need to be removed
        3. Calculate the tokens that need to be added.
        4. If the the total supply ends up being less than 
        

        """
        tokeneconomy=self.dependencies[TokenEconomy]
        purchases_in_tokens=tokeneconomy.transactions_volume_in_tokens*tokeneconomy.holding_time/tokeneconomy.price
        
        seed=int(int(time.time())*np.random.rand())
        percentage_removal=self._removal_distribution.rvs(size=1,**self._removal_dist_parameters,random_state=seed)[0]
        token_removal=purchases_in_tokens*percentage_removal
        
        self.inactive_tokens+=token_removal

        
        percentage_addition=self._addition_distribution.rvs(size=1,**self._addition_dist_parameters,random_state=seed)[0]
        tokens_coming_back=self.inactive_tokens*percentage_addition
        new_supply = self.supply + tokens_coming_back - token_removal
        
        if new_supply<=0 and not self.return_negative:
            new_supply=self.supply + tokens_coming_back
        self.supply=new_supply
        
        
        
class SupplyController_InvestorDumperSpaced(SupplyController):
    """
    Simulates an investor pool that is just dumping the coin in a predictable fashion. Supports noise addons.
    """
    
    def __init__(self,dumping_initial:float,dumping_final:float,num_steps:int,
                 space_function:Union[np.linspace,np.logspace,np.geomspace,log_saturated_space]=np.linspace,name:str=None,
                 noise_addon:AddOn=None):
        """
        

        Parameters
        ----------
        dumping_initial : float
            The initial number of tokens to be dumped.
        dumping_final : float
            DESCRIPTION.
        num_steps : int
            The number of iterations the simulation will go for.
        space_function : Union[np.linspace,np.logspace,np.geomspace,log_saturated_space], optional
            A function that will generate the sequence of supply points. The default is np.linspace.
        name : str, optional
            The name of this controller. The default is None.
        noise_addon : AddOn, optional
            Noise AddOn from the AddOns module. The default is None.

        Returns
        -------
        None.

        """
        
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
        """
        Simply executes the controller and updates the supply.

        Returns
        -------
        float
            The supply of tokens dumped.

        """
        
        self.dumping_number=self._dumping_store[self.iteration]
        
        self._dumped_tokens_store.append(self.dumping_number)
        
        self.supply=self.dumping_number
        
        self.iteration+=1
        return self.dumping_number  
        
    def get_dumped_store(self):
        
        
        return self._dumping_store
    
        
        