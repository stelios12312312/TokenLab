#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Wed Nov 30 11:03:57 2022

@author: stylianoskampakis
"""

from typing import List, Dict,Union
from baseclasses import *
from TokenLab.utils.helpers import log_saturated_space
import scipy
from scipy import stats
from scipy.stats import uniform
import time
import copy
from abc import ABC, abstractmethod 
import scipy.stats
from typing import Union


class SupplyController(Controller):
    """
    Base class for other supply controllers.
    """

    
    def __init__(self):
        super(SupplyController,self).__init__()
        self.supply=None
        self._iteration = 0


    def get_supply(self)->float:
        
        return self.supply
    
    def execute(self)->float:
        
        pass
    
    def reset(self)->bool:
        
        self._iteration = 0
        
        return True
    
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
        self._iteration=0
        
    def execute(self)->float:
        
        if self._iteration==0:
            self._iteration+=1
            return self.supply
        else:
            self._iteration+=1
            return 0
        
        
class SupplyController_FromData(SupplyController):
    
    def __init__(self,values:list,on_end_continue:bool=True):
        """
        

        Parameters
        ----------
        values : list
            The circulating supply for each iteration.
        on_end_continue : bool, optional
            If True, then the controller will keep providing the last value once it runs out of iterations
            If false, then it will raise an error. The default is True.

        Returns
        -------
        None.

        """
        super(SupplyController_FromData,self).__init__()
        
        self._supplylist = values
        self._iteration = 0
        self._on_end = on_end_continue
        
    def execute(self):
        self.supply = self._supplylist[self._iteration]
        self._iteration+=1
        
        if self._on_end and self._iteration==len(self._supplylist):
            self._iteration-=1
        elif not self._on_end and self._iteration==len(self._supplylist):
            raise Exception('Supply controller reached the end of iterations and no supply is provided!')
    

    
class SupplyController_CliffVesting(SupplyController):
    
    def __init__(self,token_amount:float,vesting_period:int,cliff:int):
        super(SupplyController_CliffVesting,self).__init__()
        
        data = []
        chunk = token_amount/vesting_period
        for i in range(cliff+vesting_period):
            if i<cliff:
                data.append(0)
            else:
                data.append(chunk)
        
        self._data= data
        
    def execute(self):
        try:
            self.supply = self._data[self._iteration]
        except:
            self.supply = 0
        
        self._iteration+=1
        
        return self.supply
        
    

class SupplyStaker(SupplyController, ABC):
    def __init__(self,staking_amount:float=0,reward_as_perc:bool=True,quit_prob:float=0):
        """
        

        Parameters
        ----------
        staking_amount : float
            DESCRIPTION.
        source : If none, then the source is the token economy. No special treatment required.
            If not None, then this has to be set to a treasury class, and rewards will come from there.

        Returns
        -------
        None.

        """
        super(SupplyController,self).__init__()
        self._staking_amount = staking_amount
        self._iteration=0
        self.dependencies={AgentPool:None}
        self.reward_as_perc=True
        self._quit_prob = quit_prob

        
    def get_staking_amount(self):
        
        return self._staking_amount
    
    def get_linked_agentpool(self):
        
        return self.dependencies[AgentPool]
    
    def quit_staking(self):
        
        self._staking_amount=0
        
    @abstractmethod
    def execute(self):
        self.source=self.get_linked_agentpool().treasury
        if np.random.rand()<self._quit_prob:
            self.quit_staking()

        pass
        
        
    
        
class SupplyStakerLockup(SupplyStaker):
    def __init__(self, staking_amount: Union[float, scipy.stats.rv_continuous], 
                 rewards: Union[float, scipy.stats.rv_continuous], lockup_duration: int,reward_as_perc:bool=True):
        """
        Staking class for lockup types of vaults

        Parameters
        ----------
        staking_amount : Union[float, scipy.stats.rv_continuous]
        rewards : Union[float, scipy.stats.rv_continuous]
            perc or fixed.
        lockup_duration : int
        reward_as_perc : bool, optional
            If true, then the reward is calculated as a percentage of the staked amount. Otherwise it is fixed. The default is True.

        Returns
        -------
        None.

        """
        super(SupplyStakerLockup, self).__init__(staking_amount,quit_prob=quit_prob)
        self.lockup_duration = lockup_duration
        self.reward_as_perc=reward_as_perc

    def execute(self):
        self.source = get_linked_agentpool().treasury
            
        if self._iteration == 0:
            value = -1 * self._get_value(self.staking_amount)
            self._staking_amount = value
        elif self._iteration == self.lockup_duration:
            if not self.reward_as_perc:
                value = self._staking_amount + self._get_value(self.rewards)
            else:
                value = self._staking_amount +  self._get_value(self.rewards)*self._staking_amount
        else:
            value = 0  # No change in supply for other iterations

        if self.source is None:
            self.supply = value
        else:
            agentpool = get_linked_agentpool()
            currency = agentpool.currency
            #remove from treasury
            agentpool.treasury.retrieve_asset(currency_symbol=currency, value=value)
            #the circulating supply increases in accordance with the total reward
            self.supply = abs(value)
            
        self._iteration+=1
        
        if np.random.rand()<self._quit_prob:
            self.quit_staking()

    def _get_value(self, param):
        try:
            return param.rvs(1)[0]  # Sample from the distribution
        except:
            return param  # Use the float value directly
    
    
class SupplyStakerMonthly(SupplyStaker):
    def __init__(self, staking_amount: Union[float, scipy.stats.rv_continuous], rewards: Union[float, scipy.stats.rv_continuous],
                 reward_as_perc:bool=True,quit_prob:float=0):
        """
        Staking class for monthly rewards. 
        
        If a treasury is used tokens go back to treasury, and rewards are taken from there as well.
        
        Once rewards are given, they return into circulating supply

        Parameters
        ----------
        staking_amount : Union[float, scipy.stats.rv_continuous]
        rewards : Union[float, scipy.stats.rv_continuous]
            perc or fixed.
        reward_as_perc : bool, optional
            If true, then the reward is calculated as a percentage of the staked amount. Otherwise it is fixed. The default is True.

        Returns
        -------
        None.

        """
        super(SupplyStakerMonthly, self).__init__(quit_prob=quit_prob)
        self.staking_amount = staking_amount
        self.rewards = rewards
        self.reward_as_perc=reward_as_perc


    def execute(self):
        self.source = super().get_linked_agentpool().treasury

        if self._iteration == 0:
            value = -1 * self._get_value(self.staking_amount)
            self._staking_amount = value
        else:
            #monthly rewards
            if not self.reward_as_perc:
                value = self._get_value(self.rewards)
            else:
                value = self._get_value(self.rewards)*self._staking_amount

        if self.source is None:
            self.supply = value
        else:
            agentpool = super().get_linked_agentpool()
            currency = agentpool.currency
            #remove from treasury
            agentpool.treasury.retrieve_asset(currency_symbol=currency, value=value)
            #the circulating supply increases in accordance with the total reward
            self.supply = abs(value)
            
        self._iteration+=1
        
        if np.random.rand()<self._quit_prob:
            self.quit_staking()

    def _get_value(self, param):
        try:
            return param.rvs(1)[0]  
        except:
            return param  
    
    
class SupplyController_Bonding(SupplyController):
    """
    This is a supply class that is used only alongside bonding curves.
    
    It simply uses the estimated number of tokens in the economy, and translates this into supply.
    """
    
    def __init__(self):
        super(SupplyController_Bonding,self).__init__()
        self.dependencies={TokenEconomy:None}
        self.supply = 0
        
    def execute(self):
        tokeneconomy=self.dependencies[TokenEconomy]
        
        if len(tokeneconomy._transactions_value_store_in_tokens)>0:
            self.supply = tokeneconomy._transactions_value_store_in_tokens[-1]
        
        
        
        
        
        
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
        
    
class SupplyController_Burn(SupplyController):
    """
    Simulates a burn mechanism.
    """
    
    def __init__(self,burn_param=0.05,burn_style='perc'):
        """
        

        Parameters
        ----------
        burn_param : int or float, optional
            Used alongside burn_style (Explained below) The default is 0.05.
        burn_style : TYPE, optional
            Choose 'perc' or 'fixed'. The default is 'perc'. Percentage means
            that you burn a %burn_param number of tokens at each iteration.
            
            Otherwise you burn a fixed number pf tokens equal to burn_param

        Returns
        -------
        None.

        """
        
        super(SupplyController_Burn,self).__init__()
        
        self.burn_param = burn_param
        self.burn_style = burn_style
        
        self.dependencies={TokenEconomy:None}

    
    
    def execute(self):
        
        tokeneconomy=self.dependencies[TokenEconomy]

        current_supply = tokeneconomy.supply
        
        if self.burn_style=='perc':
            burn_tokens = -1*current_supply*self.burn_param
        elif self.burn_style=='fixed':
            burn_tokens = -1*self.burn_param
        else:
            raise Exception('SupplyController_Burn Exception! You must define burn_style as either "fixed" or "perc"')
            
        self.supply = burn_tokens
        
        self.iteration+=1
    
        
        
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
    
        
        