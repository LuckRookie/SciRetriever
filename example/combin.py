"""Run the maintained merge utility with explicit input and output paths.

Example:
    python work/combin.py --input-db /data/a.db --input-db /data/b.db \
        --output-db /tmp/sciretriever-scratch/merged.db
"""

from work.combin import main


if __name__ == "__main__":
    main()
