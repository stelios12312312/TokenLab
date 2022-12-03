#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Nov 18 12:18:42 2022

@author: stylianoskampakis
"""
from typing import List, Dict,Union
from .baseclasses import *
from utils.helpers import log_saturated_space
import copy


class UserGrowth(Controller):
    """
    Base class that models user growth.
    """
    
    def __init__(self):
        super(UserGrowth,self).__init__()
        self.num_users=0
        return None
    
    
    def execute(self)->int:
        self.iteration = self.iteration + 1
        
        if hasattr(self,'_num_users_store'):
            #this is only for precomputed user populations, like UserGrowth_Spaced
            self.num_users=self._num_users_store[self.iteration-1]
        return self.num_users
    
    
    def get_num_users(self)->int:
        
        return self.num_users
    
    def reset(self)->None:
        
        self.iteration=0
    
    
    
class UserGrowth_Spaced(UserGrowth):
    
    """
    Creates the number of users (for a predetermined number of iterations)
    using a function that is spacing out users between min and max. Options include:
    
    linearspace, logspace, geomspace
    
    The class pre-calculates all users internally and stores them in _num_users_store.
    
    When executed it simply returns the users at the current iteration of its lifecycle.
    
    """
    
    
    def __init__(self,initial_users:int,max_users:int,num_steps:int,
                 space_function:Union[np.linspace,np.logspace,np.geomspace,log_saturated_space],name:str=None,
                 noise_addon:AddOn=None)->None:
        super(UserGrowth_Spaced,self).__init__()

                
        self._initial_users=initial_users
        self.max_users=max_users
        self.num_steps=num_steps
        self.space_function=space_function
        self._noise_component=noise_addon
        
        self.name=name
        
        self._num_users_store_original=np.round(self.space_function(start=self._initial_users,stop=self.max_users,num=num_steps)).astype(int)
        self._num_users_store=copy.deepcopy(self._num_users_store_original)
        
        #applies the noise addon. If a value is below 0, then it is kept at 0.
        if self._noise_component!=None:
            dummy=[]
            for i in range(len(self._num_users_store)):
                temporary= self._num_users_store_original[i]+ self._noise_component.apply(**{'value':self._num_users_store_original[i]})
                if temporary>=0:
                    dummy.append(temporary)
                else:
                    dummy.append(self._num_users_store_original[i])
        
            self._num_users_store=dummy
        self.num_users=self._initial_users
        
        self.max_iterations=num_steps
    
    def execute(self)->int:
        
        users=super(UserGrowth_Spaced,self).execute()
        
        return users
    
    
    def reset(self)->None:
        """
        recalcualates the noise component and sets the user counter back to 0
        """
        
        self._num_users_store=copy.deepcopy(self._num_users_store_original)
        
        #applies the noise addon. If a value is below 0, then it is kept at 0.
        if self._noise_component!=None:
            dummy=[]
            for i in range(len(self._num_users_store)):
                temporary= self._num_users_store_original[i]+ self._noise_component.apply(**{'value':self._num_users_store_original[i]})
                if temporary>=0:
                    dummy.append(temporary)
                else:
                    dummy.append(self._num_users_store_original[i])
        
            self._num_users_store=dummy
            
        self.iteration=0
        self.num_users=self._initial_users
        
        
    
    
      
class UserGrowth_Stochastic(UserGrowth):
    
    
    def __init__(self):
        
        return None
    
    def execute(self):
        
        return None
    
    
class UserGrowth_Constant(UserGrowth):
    
    def __init__(self,constant:int):
        
        super(UserGrowth_Constant,self).__init__()
        self.num_users=constant