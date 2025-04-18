"""
Configuration management for SciRetriever.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from .exceptions import ConfigError
from .logging import get_logger

logger = get_logger(__name__)


class Config:
    """Manages configuration settings for SciRetriever."""
    
    DEFAULT_CONFIG = {
        "database": {
            "path": "sciretriever.db"
        },
        "download": {
            "output_dir": "downloads",
            "rate_limit": 5.0,  # Seconds between requests
            "max_retries": 3,
            "retry_delay": 2.0,
            "timeout": 30.0
        },
        "search": {
            "default_engine": "semantic",
            "default_limit": 10,
            "auto_tag": False
        },
        "tagging": {
            "model": "local",
            "model_path": None,  # Will use default if None
            "max_tags": 5
        },
        "export": {
            "default_format": "json",
            "pretty_print": True
        },
        "api_keys": {
            "semantic_scholar": None,
            "google_scholar": None,
            "science_direct": None
        }
    }
    
    _instance = None
    
    def __new__(cls, config_path: Optional[Path] = None):
        """
        Create a singleton instance of Config.
        
        Args:
            config_path: Path to config file, if None uses default
        """
        if cls._instance is None:
            cls._instance = super(Config, cls).__new__(cls)
            cls._instance._init(config_path)
        return cls._instance
    
    def _init(self, config_path: Optional[Path] = None):
        """
        Initialize configuration.
        
        Args:
            config_path: Path to config file, if None uses default
        """
        self.config_dir = Path.home() / ".sciretriever"
        self.config_path = config_path or (self.config_dir / "config.json")
        self.config = self._load_config()
    
    def _load_config(self) -> Dict[str, Any]:
        """
        Load configuration from file or create default.
        
        Returns:
            Configuration dictionary
        """
        if self.config_path.exists():
            try:
                with open(self.config_path, 'r') as f:
                    config = json.load(f)
                logger.info(f"Loaded configuration from {self.config_path}")
                return config
            except Exception as e:
                logger.warning(f"Error loading config from {self.config_path}: {e}")
                logger.warning("Using default configuration")
                return self.DEFAULT_CONFIG.copy()
        else:
            logger.info(f"Config file not found at {self.config_path}, using defaults")
            return self.DEFAULT_CONFIG.copy()
    
    def save_config(self) -> bool:
        """
        Save configuration to file.
        
        Returns:
            True if successful, False otherwise
        """
        try:
            self.config_dir.mkdir(parents=True, exist_ok=True)
            with open(self.config_path, 'w') as f:
                json.dump(self.config, f, indent=2)
            logger.info(f"Saved configuration to {self.config_path}")
            return True
        except Exception as e:
            logger.error(f"Error saving config to {self.config_path}: {e}")
            return False
    
    def get(self, key: str, default: Any = None) -> Any:
        """
        Get a configuration value.
        
        Args:
            key: Dot-separated path to configuration value (e.g., "database.path")
            default: Default value if key not found
            
        Returns:
            Configuration value or default
        """
        keys = key.split('.')
        result = self.config
        for k in keys:
            if isinstance(result, dict) and k in result:
                result = result[k]
            else:
                return default
        return result
    
    def set(self, key: str, value: Any) -> None:
        """
        Set a configuration value.
        
        Args:
            key: Dot-separated path to configuration value (e.g., "database.path")
            value: Value to set
        """
        keys = key.split('.')
        target = self.config
        
        # Navigate to the nested dictionary
        for k in keys[:-1]:
            if k not in target:
                target[k] = {}
            elif not isinstance(target[k], dict):
                target[k] = {}
            target = target[k]
        
        # Set the value
        target[keys[-1]] = value
    
    def update(self, updates: Dict[str, Any]) -> None:
        """
        Update multiple configuration values.
        
        Args:
            updates: Dictionary of key-value pairs to update
        """
        for key, value in updates.items():
            self.set(key, value)
    
    def get_api_key(self, service: str) -> Optional[str]:
        """
        Get API key for a service.
        
        Args:
            service: Service name (e.g., "semantic_scholar")
            
        Returns:
            API key or None if not set
        """
        # First check environment variable
        env_var = f"SCIRETRIEVER_{service.upper()}_API_KEY"
        api_key = os.environ.get(env_var)
        
        # If not in environment, check config
        if not api_key:
            api_key = self.get(f"api_keys.{service}")
        
        return api_key
    
    def set_api_key(self, service: str, api_key: str) -> None:
        """
        Set API key for a service.
        
        Args:
            service: Service name (e.g., "semantic_scholar")
            api_key: API key to set
        """
        self.set(f"api_keys.{service}", api_key)
        self.save_config()


# Create public function to get config instance
def get_config() -> Config:
    """
    Get the singleton Config instance.
    
    Returns:
        Config instance
    """
    return Config()