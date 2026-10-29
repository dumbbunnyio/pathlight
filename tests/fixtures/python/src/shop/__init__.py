"""The package's entry: a barrel that offers names defined in its modules."""
from .orders import Order, place
from .catalog import *

VERSION = "1.0"
__all__ = ["Order", "place", "VERSION"]
