#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Nov 18 12:19:09 2022

@author: stylianoskampakis
"""
from baseclasses import *
from typing import List, Dict,Union
from usergrowthclasses import UserGrowth
import scipy
from scipy.stats import binom,norm,poisson
import numpy as np
from utils.helpers import log_saturated_space
import copy
import time


class TransactionManagement(Controller):
    """
    Models transactions for individual agents, by modelling them as an aggregate.
    
    """
            
    
    def __init__(self):
        super(TransactionManagement,self).__init__()
        self.dependencies={AgentPool:None,TokenEconomy:None}
        self.transactions_value=None
        #keeps a record of transactions across all iterations
        self._transactions_value_store=[]
        pass
    
    
    def execute(self,num_users):
        
        return None
    
    
    def reset(self)->None:
        
        self.iteration=0
        pass        
    
    
    def get_transactions(self)->List:
        
        return self.transactions_value
    
class TransactionManagement_Constant(TransactionManagement):
    
    def __init__(self,average_transaction_value:float):
        
        super(TransactionManagement_Constant,self).__init__()
        
        #if average_transaction_value<0:
        #    raise Exception('Average transaction value cannot be negative')
            
        self.average_transaction_value=average_transaction_value
        
        
    def execute(self,dependency="AgentPool")->float:
        """
        dependency: Available options are either AgentPool or TokenEconomy
        """
        
        if dependency=="AgentPool":
            dependency=AgentPool
        elif dependency=="TokenEconomy":
            dependency=TokenEconomy
        else:
            raise Exception('You must use either AgentPool or TokenEconomy')
            
        
        num_users=self.dependencies[dependency]['num_users']
        self.total_users=num_users
        
        self.transactions_value=num_users*self.average_transaction_value
        
        self._transactions_value_store.append(self.transactions_value)
        self.iteration+=1
        return self.transactions_value

        

class TransactionManagement_Trend(TransactionManagement):
    """
    Creates a trend of transactions (increasing or decreasing), while also accepting noise add-ons.
    
    It has a dependency on a UserGrowth class. To be used inside an agent pool.
    
    
    Properties of interest:
        
    _transactions_means_store: The average transaction size for a given iteration
    _transactions_value_store: The actual value of the transaction
    
    """
    
    def __init__(self,average_transaction_initial:float, average_transaction_final:float,num_steps:int,
                 space_function:Union[np.linspace,np.logspace,np.geomspace,log_saturated_space]=np.linspace,name:str=None,
                 noise_addon:AddOn=None):
        
        self.dependencies={AgentPool:None}

        
        self.num_steps=num_steps
        self.space_function=space_function
        self._noise_component=noise_addon
        
        self.name=name
        
        self._transactions_means_store_original=np.round(self.space_function(start=average_transaction_initial,stop=average_transaction_final,num=num_steps)).astype(int)
        self._transactions_means_store=copy.deepcopy(self._transactions_means_store_original)
        
        #applies the noise addon. If a value is below 0, then it is kept at 0.
        if self._noise_component!=None:
            dummy=[]
            for i in range(len(self._transactions_means_store)):
                temporary= self._transactions_means_store_original[i]+ self._noise_component.apply(**{'value':self._transactions_means_store_original[i]})
                if temporary>=0:
                    dummy.append(temporary)
                else:
                    dummy.append(self._transactions_means_store_original[i])
        
            self._transactions_means_store=dummy
        
        self.max_iterations=num_steps
        self._transactions_value_store=[]
        
        
    def execute(self)->float:
        
        num_users=self.dependencies[UserGrowth].get_num_users()
        self.total_users=num_users
        
        self.transactions_value=num_users*self._transactions_means_store[self.iteration]
        
        self._transactions_value_store.append(self.transactions_value)
        self.iteration+=1
        return self.transactions_value   

        
    def reset(self)->float:
        
        self.iteration=0
        self._transactions_means_store=copy.deepcopy(self._transactions_means_store_original)
        
        #applies the noise addon. If a value is below 0, then it is kept at 0.
        if self._noise_component!=None:
            dummy=[]
            for i in range(len(self._transactions_means_store)):
                temporary= self._transactions_means_store_original[i]+ self._noise_component.apply(**{'value':self._transactions_means_store_original[i]})
                if temporary>=0:
                    dummy.append(temporary)
                else:
                    dummy.append(self._transactions_means_store_original[i])
        
            self._transactions_means_store=dummy
    
    
class TransactionManagement_Stochastic(TransactionManagement):
    """
    Users a simple binomial distribution to model the number of active users.
    
    Uses the normal distribution to simulate the transaction value.
    
    So, at each iteration the execute() function does the following
    
    1) Uses the binomial distribution to simulate the number of active users.
    2) Uses the value_mean parameter and the value_std to calculate the average value of transactions.
    3) Uses 1 and 2 to get an estimate of the total value.
    
    
    
    Dependent class: The execute() argument is reading from a UserGrowth class that provides
    the current number of users
    
    
    """



    def __init__(self,
                 value_per_transaction:float=None,
                 transactions_per_user:Union[int,list[int]]=None,
                 value_distribution:scipy.stats=norm,transactions_distribution:scipy.stats=poisson,
                 value_dist_parameters:Union[Dict[str,float],List[Dict[str,float]]]={'loc':10,'scale':100},
                 transactions_dist_parameters:Union[Dict[str,float],List[Dict[str,float]]]={'mu':5},name:str=None,
                 activity_probs:Union[float,list[float]]=1,type_transaction:str='positive')->None:
        
        """
        activity_probs: This is either a float or a list of floats, and determines the parameter p of the binomial
        distribution
        
        value_per_transaction: If this is set, then the value per transaction is fixed, and overrides the distribution. Otherwise,
        leave to None.
        
        transactions_per_user: If this is set, then the number of transactions is fixed, and overrides the distribution. Otherwise, 
        leave to None.
        
        value_dist_parameters: Parameters for the value distribution. This can also be a list of dictionaries, where each dictionary
        within the list is a set of parameters. The values inside the dictionary must use the keys 'loc' and 'scale'.
        
        value_distribution: by default this is the normal distribution, but any scipy distribution 
         is supported.
        
        transactions_distribution: uses a distribution to model the number of transactions per user. By default
        this is a Poisson distribution
        
        transactions_dist_parameters: Parameters for the transaction distribution. This can also be a list of dictionaries, where each dictionary
        within the list is a set of parameters.
        
        type_transaction: positive (positive transactions only), negative or mixed. It is positive by default
        
        
        The value at each iteration of execution is sampled from the value distribution (if the distribution is set)
        
        The final equation is using the following formulas when value distribution is active:
            
        total value = distribution(loc,scale)
        a) loc = num_active_users*num_transactions*value_per_transaction(or loc parameter)
        b) scale = scale 
    
        If the value distribution is absent, and a value_per_transaction is defined instead, then
        the formula becomes:
            
        total value = val_mean*self.active_users*trans
        
        NOTE: Average transactions per user can never be below 0. If 0 (due to random sampling) then it's set to 1
        
        
        """
        super(TransactionManagement_Stochastic,self).__init__()
        self.name=name

        self.active_users=0
        self.total_users=0
        self._transactions_value_store=[]
        
        self.dependencies={AgentPool:None}
        
        self.activity_probabilities=activity_probs
        
        
        self.transactions_distribution=transactions_distribution
        self.transactions_per_user=transactions_per_user
        self.transaction_dist_parameters=transactions_dist_parameters

        
        self.value_distribution=value_distribution
        self.value_per_transaction=value_per_transaction
        self.value_dist_parameters=value_dist_parameters
        
        if type_transaction not in ['positive','negative','mix']:
            raise Exception ('You must define a type_transaction as positive, negative or mixed')
        
        self.type_transaction=type_transaction
        
        if value_per_transaction==None and value_dist_parameters==None:
            raise Exception('You need to define at least value per transaction or value_dist_parameters')
            
        if transactions_per_user==None and transactions_dist_parameters==None:
            raise Exception('You need to define at least transaction_per_user or transaction_dist_parameters')
        
        
        #sanity test, all lists should be the same length
        lengths=[]
        if isinstance(self.value_dist_parameters,(list,np.ndarray)):
            self.max_iterations=len(self.value_dist_parameters)
            lengths.append(len(self.value_dist_parameters))
        
        if isinstance(self.transaction_dist_parameters,(list,np.ndarray)):
            self.max_iterations=len(self.transaction_dist_parameters)
            lengths.append(len(self.transaction_dist_parameters))
            
        if isinstance(self.activity_probabilities,(list,np.ndarray)):
            self.max_iterations=len(self.activity_probabilities)
            lengths.append(len(self.activity_probabilities))
            
        if len(set(lengths))>1:
            raise Exception('When supplying lists as arguments, they should all have the same length.')

        return None
    
    
    def execute(self)->float:
        num_users=self.dependencies[AgentPool].get_num_users()
        self.total_users=num_users
        
        #because activitiy_probabilities can be either an int or a list, we have to take into account both scenarios
        if isinstance(self.activity_probabilities,(list,np.ndarray)):
            act=self.activity_probabilities[self.iteration]
        else:
            act=self.activity_probabilities
            
        seed=int(int(time.time())*np.random.rand())
        self.active_users=binom.rvs(int(num_users),act,random_state=seed)
            
            
        if isinstance(self.transaction_dist_parameters,(list,np.ndarray)):
            trans_param=self.transaction_dist_parameters[self.iteration] 
        else:
            trans_param=self.transaction_dist_parameters
            
            
        if self.transactions_per_user is None:
            seed=int(int(time.time())*np.random.rand())
            trans=self.transactions_distribution.rvs(size=1,**trans_param,random_state=seed)[0]
            if trans<=0:
                trans=1
        else:
            trans=self.transactions_per_user
            
        self.num_transactions=trans
            
        
        if isinstance(self.value_dist_parameters,(list,np.ndarray)):
            val_param=self.value_dist_parameters[self.iteration]
        else:
            val_param=self.value_dist_parameters
        
        if self.value_per_transaction is None:
            seed=int(int(time.time())*np.random.rand())
            value_mean=self.value_distribution.rvs(size=1,loc=val_param['loc']*self.active_users*trans,scale=val_param['scale'],random_state=seed)[0]
        else:
            value_mean=self.value_per_transaction*self.active_users*trans
            
        #transaction value can never be negative
        if value_mean<0 and self.type_transaction=='positive':
            value_mean=0
        elif value_mean>0 and self.type_transaction=='negative':
            value_mean=0
            
        
        self.transactions_value=value_mean
        
        self._transactions_value_store.append(value_mean)
        self.iteration+=1
        return self.transactions_value        
        