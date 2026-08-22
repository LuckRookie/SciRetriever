"""Private protocol adapter implementations.

The package intentionally has no public exports.  Production consumers bind
the provider-neutral :mod:`sciretriever.agents` Port; only bootstrap imports a
concrete adapter module by its explicit protocol name.
"""

__all__: tuple[str, ...] = ()
