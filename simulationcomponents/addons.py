#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Wed Nov 30 10:34:43 2022

@author: stylianoskampakis
"""
import numpy as np
from simulationcomponents.baseclasses import *
import scipy
from scipy.stats import binom,norm
import time
import warnings
from typing import Callable


class AddOn_Noise(AddOn):
    
    def __init__(self):
        
        pass
    
    def apply(self,**kwargs)->float:
        
        pass

class AddOn_RandomNoise(AddOn_Noise):
    """
    Adds random noise (normaly gaussian) to a parameter
    """
    
    def __init__(self,noise_dist:scipy.stats=scipy.stats.norm,
                 dist_params:Dict={'loc':0,'scale':1})->None:
        
        self.noise_dist=noise_dist
        self.dist_params=dist_params
        
    
    #need to use **kwargs for compatibility with other classes that take input 
    #like AddOn_RandomNoiseProportional
    def apply(self,**kwargs)->float:
        seed=int(int(time.time())*np.random.rand())
        noise=self.noise_dist.rvs(size=1,**self.dist_params,random_state=seed)[0]
        
        return noise



class AddOn_RandomNoiseProportional(AddOn_Noise):
    """
    Adds random noise (normaly gaussian) to a parameter. The scale is dependent on the actual input value.
    So, if we use gaussian, the std becomes value/std_param. So, if we apply this on price for example,
    the more the price increases in size, the more volatility is induced.
    """
    
    def __init__(self,noise_dist:scipy.stats=scipy.stats.norm,
                 mean_param=0,std_param=5)->None:
        
        self.noise_dist=noise_dist
        self.mean_param=mean_param
        self.std_param=std_param
        
        
    def apply(self,value)->float:
        seed=int(int(time.time())*np.random.rand())
        noise=self.noise_dist.rvs(size=1,loc=self.mean_param,scale=value/self.std_param,random_state=seed)[0]
        
        return noise


class Condition():
    """

    
    Example usage:
        
        usm_fiat=UserGrowth_Spaced(100,54000,ITERATIONS,log_saturated_space)
        ap_fiat=AgentPool_Basic(users_controller=usm_fiat,transactions_controller=100,currency='$')
        
        Condition(ap_fiat,['transactions'],lambda x:x[0]>1000)
    """

    def __init__(self,variables:List[str],condition:Callable,sim_component:Union[TokenEconomy,Controller]=None):
        """
        variables: The variables must be in a list of the variables that the condition must access. 
        
        condition:  A lambda expression or function that accepts a list of variables and returns a Boolean. 
        The condition must use brackets [] to access the variables. e.g. Condition(ap_fiat,['transactions'],lambda x:x[0]>1000)
        
        sim_component: the module where the variables will be read from
        
        """
        self.sim_component=sim_component
        self.condition=condition
        self.variables=variables
        self.result=None
        
        return None
        
    
    def execute(self):
        
        var_list=[]
        for vari in self.variables:
            var_list.append(self.sim_component[vari])
            
        res=self.condition(var_list)

        self.result=res
        
        return res
    
    def get_result(self):
        if self.result==None:
            warnings.warn('Condition has not executed yet. Returning None.')
        
        return self.result
        
        
        

# class AddOn_ControlFlowBoolean(AddOn):
    
#     """
    
#     """
#     def __init__(self,List[Condition]=None):
#        self.dependencies=dependencies
#        self.conditions=conditions
       
       
#     def apply(self):
#         for dep in self.conditions:
            
        
#         pass
        
    
    
        
        
        