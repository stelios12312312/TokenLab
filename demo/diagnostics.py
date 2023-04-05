import numpy as np
import scipy
import sys
import os

import pandas as pd

tokenlab_path=os.path.abspath("").replace('demo','src')
sys.path.insert(0,tokenlab_path)




from TokenLab.simulationcomponents import *
from TokenLab.simulationcomponents.usergrowthclasses import *
from TokenLab.simulationcomponents.transactionclasses import *
from TokenLab.simulationcomponents.tokeneconomyclasses import *
from TokenLab.simulationcomponents.transactionclasses import *
from TokenLab.simulationcomponents.agentpoolclasses import *
from TokenLab.simulationcomponents.pricingclasses import *
from TokenLab.simulationcomponents.addons import AddOn_RandomNoise, AddOn_RandomNoiseProportional
from TokenLab.utils.helpers import *
from matplotlib import pyplot as plt

import mercury as mr
app = mr.App(title="TokenLab Demo - simple fee economy", description="Let us show you what TokenLab can do!") 

