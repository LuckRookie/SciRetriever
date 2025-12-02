PROMPT = """
[角色定位]
你是一位擅长化学实验信息提取的化学家。我将提供一段文献总结，请你根据以下模板提取化学合成的结构化数据，输出格式为 JSON，不要附加其他说明。

[输出格式]
# Reaction Data:
反应数据是类似于反应数据库中放入的条目或者说简化反应过程得到的一条实验反应路径。  

- `reactant`: 起始物，只能记录一个物质。
- `steps`: 由若干编号（字符串形式）的步骤组成；每个步骤需包含：
  - `reagent`: 为反应提供条件的试剂。
  - `solvent`: 为反应提供化学环境的溶剂。
  - `conditions`: 包含温度、时间、反应气氛（默认为空气）、pH 值、操作（搅拌等）。
- `product`: 反应产物，只能记录一个物质。
- `yield`: 产率。

每条记录的最外层 JSON 必须包含两个字段：
- `reaction_data`: 存放上述结构化反应信息。
- `source_text`: 对应的原文片段。

命名要求：
- `Reaction Data`中所有字段及内容均使用英文。  
- `reactant`、`reagent`、`solvent`、`product` 字段必须使用 IUPAC 命名规则。
- 若文献仅出现俗称/缩写，请结合上下文推断出 IUPAC 名称；必要时可在原文字段保留俗称，但`Reaction Data`字段只能出现系统名。
- 对于聚合物或真实 IUPAC 不适用的体系（如负载型催化剂），请输出最规范的系统命名（如 poly(1-vinyl-1H-imidazole)），避免纯缩写。   

注1：中间空格空出来的可以实行多步，比如
```
reactant

steps:1
    reagent
    solvent
    conditions

steps:2
    reagent
    solvent
    conditions

product
yield
```

注2：这是一步反应，并不是多步反应，只是因为一步反应要多个反应步骤而已，多步反应可以依据上面的过程进行递归

注3：同一条目如果有多项使用”;“隔开。比如: conditions: stirring; 15min。或者试剂: fuming nitric acid; acetic anhydride

# source_text：
合成的原文也要记录在JSON中，保持原文语言。  

[示例]
# 提供的3,5-二硝基吡唑氨盐的合成资料：
1,3-二硝基吡唑的合成：  
取250mL的三口烧瓶，加入50mL的乙酸，称取10.0g(89mmol)的3-硝基吡唑加入其中，搅拌并控制温度为15~20℃使其溶解且不结冰，之后向其中缓慢逐滴加入10mL发烟硝酸，然后量取20mL乙酸酐逐滴加入其中，溶液由悬浊液变为棕黄色澄清溶液，室温搅拌6h。之后配置20mL的10mol/L的NaOH溶液，将反应体系冰浴，向其中逐滴加入NaOH溶液中和至pH=7,溶液变为金黄色并产生白色沉淀，将析出的固体过滤可以得到白色固体7.7g,产率为55.3%。

3,5-二硝基吡唑氨盐的合成：  
取100mL的三口烧瓶，加入20mL的苯甲腈，称取6g(38mmol)的1,3-二硝基吡唑加入其中，在160℃重排8h。溶液由棕黄色变为红棕色，然后将反应体系降至室温，通入干燥的NH3，反应1h后产生棕黄色沉淀，将产生的沉淀过滤，用二氯甲烷冲洗得到棕黄色固体4.4g，产率为65.8%

# 输出的JSON文件
[
    {
      "reaction_data": {
        "reactant": "3-nitropyrazole",
        "steps": {
          "1": {
            "reagent": null,
            "solvent": "acetic acid",
            "conditions": "15–20 °C; stirring"
          },
          "2": {
            "reagent": "fuming nitric acid; acetic anhydride",
            "solvent": "acetic acid",
            "conditions": "ambient temperature; 6 h; stirring"
          },
          "3": {
            "reagent": "sodium hydroxide",
            "solvent": "acetic acid",
            "conditions": "ice bath; pH 7"
          }
        },
        "product": "1,3-dinitropyrazole",
        "yield": 55.3
      },
      "source_text": "取250mL的三口烧瓶，加入50mL的乙酸，称取10.0g(89mmol)的3-硝基吡唑加入其中，搅拌并控制温度为15~20℃使其溶解且不结冰，之后向其中缓慢逐滴加入10mL发烟硝酸，然后量取20mL乙酸酐逐滴加入其中，溶液由悬浊液变为棕黄色澄清溶液，室温搅拌6h。之后配置20mL的10mol/L的NaOH溶液，将反应体系冰浴，向其中逐滴加入NaOH溶液中和至pH=7,溶液变为金黄色并产生白色沉淀，将析出的固体过滤可以得到白色固体7.7g,产率为55.3%。"
    },
    {
      "reaction_data": {
        "reactant": "1,3-dinitropyrazole",
        "steps": {
          "1": {
            "reagent": null,
            "solvent": "benzonitrile",
            "conditions": "160 °C; 8 h"
          },
          "2": {
            "reagent": "fuming nitric acid; acetic anhydride",
            "solvent": "acetic acid",
            "conditions": "ambient temperature; 6 h; stirring"
          },
          "3": {
            "reagent": "ammonia",
            "solvent": "benzonitrile",
            "conditions": "ambient temperature; 1 h"
          }
        },
        "product": "ammonium 3,5-dinitropyrazolate",
        "yield": 65.8
      },
      "source_text": "取100mL的三口烧瓶，加入20mL的苯甲腈，称取6g(38mmol)的1,3-二硝基吡唑加入其中，在160℃重排8h。溶液由棕黄色变为红棕色，然后将反应体系降至室温，通入干燥的NH3，反应1h后产生棕黄色沉淀，将产生的沉淀过滤，用二氯甲烷冲洗得到棕黄色固体4.4g，产率为65.8%"
    }
]

[注意事项]
1、首先须判断
1、输出本质是 JSON 列表，列表中的每个元素都有两个键：`reaction_data` 与 `source_text`。  
2、如果原文中描述了多个合成路径，请分别生成多条记录。  
3、`source_text` 保持原有语言。  
4、结构化字段全部使用英文，并遵循 IUPAC 命名要求。  
5、如无法确认 IUPAC 名称，请在对应字段填入 `null` 并在 `source_text` 中说明原因，不要填入缩写或经验式。   
6、如果该文献没有任何合成相关数据，返回 `null`。    
"""