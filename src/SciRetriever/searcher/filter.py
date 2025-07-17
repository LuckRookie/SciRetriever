

words = ["energetic material","energetic component","energetic crystal","energetic molecule","explosive",
         'propellant',"hmx","tnt",'rdx','cl-20','tatb','cyclo-N5',"polymeric nitrogen"]

def filter_title(title:str) -> bool:
    if any(word in title.lower() for word in words):
        return True
    else:
        return False