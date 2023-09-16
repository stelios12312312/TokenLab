#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Nov 18 12:18:42 2022

@author: stylianoskampakis
"""

from typing import List, Dict,Union
from baseclasses import *
from TokenLab.utils.helpers import log_saturated_space
import copy
import scipy
import warnings
import time


class UserGrowth(Controller):
    """
    Base class that models user growth. Dependencies include AgentPool and TokenEconomy.
    """
    
    def __init__(self):
        super(UserGrowth,self).__init__()
        self.num_users=0
        
        #conditional dependence, it is used only in conditions
        self.dependencies={AgentPool:None,TokenEconomy:None}
        
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
        """
        Resets the iteration counter to 0.

        """
        self.iteration=0
    
    
    
class UserGrowth_Spaced(UserGrowth):
    
    """
    Creates the number of users (for a predetermined number of iterations)
    using a function that is spacing out users between min and max. Options include:
    
    linearspace, logspace, geomspace, logistic
    
    The class pre-calculates all users internally and stores them in _num_users_store.
    
    When executed it simply returns the users at the current iteration of its lifecycle.
    
    """
    
    
    def __init__(self,initial_users:int,max_users:int,num_steps:int,
                 space_function:Union[np.linspace,np.logspace,np.geomspace,log_saturated_space]=np.linspace,name:str=None,
                 noise_addon:AddOn=None,use_difference:bool=False)->None:
        """
        use_difference: If True, it will calculate and return the difference between time steps. Essentially, the user 
        base will grow according to the difference between the steps in the sequence.
        
        Otherwise, it returns the actual value.
        
        For example:
            initial_users=100
            growth=[100,120,150,200]
            final=[100,120,150,200]
            
            with difference:
                final=[100,0,20,30,50]
            
        """
        super(UserGrowth_Spaced,self).__init__()

                
        self._initial_users=initial_users
        self.max_users=max_users
        self.num_steps=num_steps
        self.space_function=space_function
        self._noise_component=noise_addon
        
        self.name=name
        
        self._num_users_store_original=np.round(self.space_function(start=self._initial_users,
                                                                    stop=self.max_users,num=num_steps)).astype(int)
        self._num_users_store=copy.deepcopy(self._num_users_store_original)

        #applies the noise addon. If a value is below 0, then it is kept at 0.
        if self._noise_component!=None:
            dummy=[]
            for i in range(len(self._num_users_store_original)):
                temporary= self._num_users_store_original[i]+ self._noise_component.apply(**{'value':self._num_users_store_original[i]})
                if temporary>=0:
                    dummy.append(temporary)
                else:
                    dummy.append(self._num_users_store_original[i])
        
            self._num_users_store=dummy
        #self.num_users=self._initial_users
        
        if use_difference:
            self._num_users_store_original=[self._initial_users]+np.diff(self._num_users_store_original).tolist()
        
            self._num_users_store=copy.deepcopy(self._num_users_store_original)

        
        self.max_iterations=num_steps
    
    def execute(self)->int:
        
        users=super(UserGrowth_Spaced,self).execute()
        
        return users
    
    
    def reset(self)->None:
        """
        recalculates the noise component and sets the user counter back to 0
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
        
        
    def get_users_store(self)->List:
        """
        Returns the list that contains the pre-calculated number of users. This is a
        private variable.

        """
        
        return self._num_users_store
    
    def get_data(self)->List:
        """
        Used for compatibility reasons
        """
        
        return self.get_users_store()
    
    
    
        
class UserGrowth_Constant(UserGrowth):
    """
    Simplest type of usergrowth class. The user growth simply stays constant.
    """
    
    def __init__(self,constant:int):
        """
        
        Parameters
        ----------
        constant : int
            The total number of users.

        """
        
        super(UserGrowth_Constant,self).__init__()
        self.num_users=constant        
    
    
      
class UserGrowth_Stochastic(UserGrowth):
    """
    UserGrowth that simply samples a random value during each iteration.
    
    """
    
    
    def __init__(self,user_growth_distribution:scipy.stats=scipy.stats.poisson,
                 user_growth_dist_parameters:Union[List,Dict]=[{'mu':1000}],add_to_userbase:bool=False,
                 num_initial_users:int=0):
        """
        

        Parameters
        ----------
        user_growth_distribution : scipy.stats, optional
            The distribution to sample values from. The default is scipy.stats.poisson.
        
        user_growth_dist_parameters : Union[List,Dict], optional
            Either a list of dictionaries, or a dictionary. If a list is provided
            then the parameters change at every iteration. The default is [{'mu':1000}].
        
        add_to_user_base : bool, optional 
        If False, then the actual number of users is sampled from the distribution. If True,
        then this number of users is added to the total number of users. Default is false.
        
        num_initial_users : int, optional
        The number of initial users. Default is 0
        """
        
        super(UserGrowth_Stochastic,self).__init__()

        
        self.user_growth_distribution=user_growth_distribution
        self.user_growth_dist_parameters=user_growth_dist_parameters
        self.num_users=num_initial_users
        self.add_to_userbase=add_to_userbase
        
        
        return None
    
    def execute(self):
        seed=int(int(time.time())*np.random.rand())
        if type(self.user_growth_dist_parameters)==list:
            try:
                params=self.user_growth_dist_parameters[self.iteration]
            except:
                warnings.warn("Iterations for UserGrowth stochastic exhausted. Simply using the last item on the list of parameters.")
                params=self.user_growth_dist_parameters[-1]
        else:
            params=self.user_growth_dist_parameters
            
        self._active_params=params
        value=self.user_growth_distribution.rvs(size=1,random_state=seed,**params)[0]
        
        if self.add_to_userbase:
            self.num_users+=value
        else:
            self.num_users=value
        
        self.iteration+=1
        return self.num_users
    
    
