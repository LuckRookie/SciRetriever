import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Button,
  Checkbox as AriaCheckbox,
  ComboBox as AriaComboBox,
  FieldError,
  Group,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  NumberField as AriaNumberField,
  Popover,
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  SearchField as AriaSearchField,
  Select as AriaSelect,
  SelectValue,
  Switch as AriaSwitch,
  Text,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
} from "react-aria-components";
import { Icon } from "./icons.js";
/**
 * How much the value needs: a count or year (short), a name or choice
 * (medium), a path, URL or sentence (long), or the whole line (full). Each
 * field has a default; the slot never stretches past what its value needs.
 */
export type FieldWidth = "short" | "medium" | "long" | "full";
export interface FieldProps {
  label: string;
  description?: string;
  errorMessage?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  width?: FieldWidth;
  children?: ReactNode;
}
const fieldClass = (width: FieldWidth | undefined, fallback: FieldWidth) =>
  `ui-field ui-field-${width ?? fallback}`;
export function Field({
  label,
  description,
  errorMessage,
  isRequired,
  children,
}: FieldProps) {
  return (
    <>
      <Label className="ui-label">
        {label}
        {isRequired ? (
          <span aria-hidden="true" className="ui-required">
            {" "}
            *
          </span>
        ) : null}
      </Label>
      {children}
      {description ? (
        <Text className="ui-description" slot="description">
          {description}
        </Text>
      ) : null}
      {errorMessage ? (
        <FieldError className="ui-error-text">{errorMessage}</FieldError>
      ) : null}
    </>
  );
}
export interface TextFieldProps extends FieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password" | "email" | "url";
  name?: string;
  autoComplete?: string;
  maxLength?: number;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}
export function TextField({
  value,
  onChange,
  placeholder,
  type = "text",
  name,
  autoComplete,
  maxLength,
  onKeyDown,
  ...field
}: TextFieldProps) {
  return (
    <AriaTextField
      className={fieldClass(field.width, "medium")}
      value={value}
      onChange={onChange}
      type={type}
      {...(name ? { name } : {})}
      isDisabled={field.isDisabled ?? false}
      isRequired={field.isRequired ?? false}
      isInvalid={!!field.errorMessage}
    >
      <Field {...field}>
        <Input
          className="ui-input"
          {...(placeholder ? { placeholder } : {})}
          {...(autoComplete ? { autoComplete } : {})}
          {...(maxLength === undefined ? {} : { maxLength })}
          {...(onKeyDown ? { onKeyDown } : {})}
        />
      </Field>
    </AriaTextField>
  );
}
export function SearchField({
  value,
  onChange,
  placeholder,
  onSubmit,
  ...field
}: Omit<TextFieldProps, "type" | "autoComplete" | "onKeyDown"> & {
  onSubmit?: (value: string) => void;
}) {
  return (
    <AriaSearchField
      className={fieldClass(field.width, "full")}
      value={value}
      onChange={onChange}
      {...(onSubmit ? { onSubmit } : {})}
      isDisabled={field.isDisabled ?? false}
      isRequired={field.isRequired ?? false}
      isInvalid={!!field.errorMessage}
    >
      <Field {...field}>
        <Group className="ui-search">
          <Icon name="search" />
          <Input
            className="ui-search-input"
            {...(placeholder ? { placeholder } : {})}
          />
          <Button className="ui-clear" aria-label="清除搜索">
            <Icon name="close" />
          </Button>
        </Group>
      </Field>
    </AriaSearchField>
  );
}
export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
  maxLength,
  ...field
}: Omit<TextFieldProps, "type" | "autoComplete" | "onKeyDown"> & {
  rows?: number;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (input.current) {
      input.current.style.height = "auto";
      input.current.style.height = `${Math.min(input.current.scrollHeight, 300)}px`;
    }
  }, [value]);
  return (
    <AriaTextField
      className={fieldClass(field.width, "long")}
      value={value}
      onChange={onChange}
      isDisabled={field.isDisabled ?? false}
      isRequired={field.isRequired ?? false}
      isInvalid={!!field.errorMessage}
    >
      <Field {...field}>
        <AriaTextArea
          ref={input}
          className="ui-input ui-textarea"
          rows={rows}
          {...(placeholder ? { placeholder } : {})}
          {...(maxLength === undefined ? {} : { maxLength })}
        />
      </Field>
    </AriaTextField>
  );
}
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  description?: string;
}
export function Select({
  value,
  onChange,
  options,
  placeholder = "请选择",
  prefix,
  ...field
}: FieldProps & {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  /** Words shown before the value in the button, as in “排序：最近入库”. */
  prefix?: string;
}) {
  return (
    <AriaSelect
      className={fieldClass(field.width, "medium")}
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key));
      }}
      placeholder={placeholder}
      // Select owns the collection state; disabledKeys on the inner ListBox is ignored.
      disabledKeys={options
        .filter((option) => option.disabled)
        .map((option) => option.value)}
      isDisabled={field.isDisabled ?? false}
      isRequired={field.isRequired ?? false}
      isInvalid={!!field.errorMessage}
    >
      <Field {...field}>
        <Button className="ui-select">
          {prefix ? (
            <span className="ui-select-prefix" aria-hidden>
              {prefix}：
            </span>
          ) : null}
          <SelectValue />
          <Icon name="chevron" />
        </Button>
        <Popover className="ui-popover" placement="bottom start">
          <ListBox className="ui-listbox" items={options}>
            {(option) => (
              <ListBoxItem
                className="ui-option"
                id={option.value}
                textValue={option.label}
              >
                <Text slot="label">{option.label}</Text>
                {option.description ? (
                  <Text slot="description" className="ui-description">
                    {option.description}
                  </Text>
                ) : null}
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </Field>
    </AriaSelect>
  );
}
/**
 * Free-text field with picked suggestions: typing filters by text, choosing a
 * suggestion replaces the text with that item. One control for "type or pick".
 */
export function SuggestField({
  text,
  onTextChange,
  selected,
  onSelect,
  suggestions,
  placeholder,
  ...field
}: FieldProps & {
  text: string;
  onTextChange: (text: string) => void;
  selected: string;
  onSelect: (value: string) => void;
  suggestions: readonly SelectOption[];
  placeholder?: string;
}) {
  const label = suggestions.find((option) => option.value === selected)?.label;
  return (
    <AriaComboBox
      className={fieldClass(field.width, "full")}
      allowsCustomValue
      menuTrigger="focus"
      inputValue={selected ? (label ?? "") : text}
      onInputChange={(next) => {
        if (selected && next === label) return;
        if (selected) onSelect("");
        onTextChange(next);
      }}
      selectedKey={selected || null}
      onSelectionChange={(key) => {
        if (key === null) return;
        onSelect(String(key));
        onTextChange("");
      }}
      items={suggestions}
      isDisabled={field.isDisabled ?? false}
    >
      <Field {...field}>
        <Group className="ui-search">
          <Icon name="search" />
          <Input
            className="ui-search-input"
            {...(placeholder ? { placeholder } : {})}
          />
          {text || selected ? (
            <Button
              className="ui-clear"
              aria-label="清除"
              onPress={() => {
                onSelect("");
                onTextChange("");
              }}
            >
              <Icon name="close" />
            </Button>
          ) : null}
        </Group>
        <Popover className="ui-popover" placement="bottom start">
          <ListBox className="ui-listbox">
            {(option: SelectOption) => (
              <ListBoxItem
                className="ui-option"
                id={option.value}
                textValue={option.label}
              >
                <Text slot="label">{option.label}</Text>
                {option.description ? (
                  <Text slot="description" className="ui-description">
                    {option.description}
                  </Text>
                ) : null}
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </Field>
    </AriaComboBox>
  );
}
export function NumberField({
  value,
  onChange,
  minValue,
  maxValue,
  step,
  placeholder,
  formatOptions,
  live = false,
  stepper = true,
  ...field
}: FieldProps & {
  value: number;
  onChange: (value: number) => void;
  minValue?: number;
  maxValue?: number;
  step?: number;
  placeholder?: string;
  formatOptions?: Intl.NumberFormatOptions;
  /** Report each typed in-range value instead of waiting for blur or Enter. */
  live?: boolean;
  /** Plus and minus buttons, only where stepping means something (design core rule 11). */
  stepper?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <AriaNumberField
      className={fieldClass(field.width, "short")}
      value={focused ? draft : value}
      onChange={(next) => {
        setDraft(next);
        onChange(next);
      }}
      isDisabled={field.isDisabled ?? false}
      isRequired={field.isRequired ?? false}
      isInvalid={!!field.errorMessage}
      {...(minValue === undefined ? {} : { minValue })}
      {...(maxValue === undefined ? {} : { maxValue })}
      {...(step === undefined ? {} : { step })}
      {...(formatOptions ? { formatOptions } : {})}
    >
      <Field {...field}>
        <Group className="ui-number">
          <Input
            className="ui-number-input"
            {...(placeholder ? { placeholder } : {})}
            onFocus={() => {
              setDraft(value);
              setFocused(true);
            }}
            onBlur={() => setFocused(false)}
            {...(live
              ? {
                  onInput: (event: FormEvent<HTMLInputElement>) => {
                    const text = event.currentTarget.value.replace(
                      /[\s,，]/g,
                      "",
                    );
                    const next = text === "" ? Number.NaN : Number(text);
                    if (
                      Number.isFinite(next) &&
                      next !== value &&
                      (minValue === undefined || next >= minValue) &&
                      (maxValue === undefined || next <= maxValue)
                    )
                      onChange(next);
                  },
                }
              : {})}
          />
          {stepper ? (
            <>
              <Button
                slot="decrement"
                className="ui-number-step"
                aria-label="减少"
              >
                <Icon name="minus" />
              </Button>
              <Button
                slot="increment"
                className="ui-number-step"
                aria-label="增加"
              >
                <Icon name="plus" />
              </Button>
            </>
          ) : null}
        </Group>
      </Field>
    </AriaNumberField>
  );
}
export function Checkbox({
  children,
  label,
  isSelected,
  onChange,
  isDisabled = false,
  isIndeterminate = false,
  "aria-label": ariaLabel,
}: {
  children?: ReactNode;
  label?: string;
  isSelected: boolean;
  onChange: (value: boolean) => void;
  isDisabled?: boolean;
  isIndeterminate?: boolean;
  "aria-label"?: string;
}) {
  return (
    <AriaCheckbox
      className="ui-choice"
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
      isIndeterminate={isIndeterminate}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
    >
      <span className="ui-checkbox-mark">
        <Icon name={isIndeterminate ? "minus" : "check"} />
      </span>
      {children ?? label}
    </AriaCheckbox>
  );
}
export function Radio({
  children,
  value,
  isDisabled = false,
}: {
  children: ReactNode;
  value: string;
  isDisabled?: boolean;
}) {
  return (
    <AriaRadio className="ui-choice" value={value} isDisabled={isDisabled}>
      <span className="ui-radio-mark" />
      {children}
    </AriaRadio>
  );
}
export function RadioGroup({
  children,
  value,
  onChange,
  segmented = false,
  ...field
}: FieldProps & {
  children: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** Two or three mutually exclusive options shown as one segmented control. */
  segmented?: boolean;
}) {
  return (
    <AriaRadioGroup
      className={segmented ? "ui-field ui-radio-segmented" : "ui-field"}
      value={value}
      onChange={onChange}
      isDisabled={field.isDisabled ?? false}
      isRequired={field.isRequired ?? false}
      isInvalid={!!field.errorMessage}
    >
      <Field {...field}>
        {segmented ? (
          <div className="ui-segmented-options">{children}</div>
        ) : (
          children
        )}
      </Field>
    </AriaRadioGroup>
  );
}
export function Switch({
  children,
  isSelected,
  onChange,
  isDisabled = false,
}: {
  children: ReactNode;
  isSelected: boolean;
  onChange: (value: boolean) => void;
  isDisabled?: boolean;
}) {
  return (
    <AriaSwitch
      className="ui-choice"
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
    >
      <span className="ui-switch-track">
        <span />
      </span>
      {children}
    </AriaSwitch>
  );
}
/**
 * A file chooser in the site's own button and words: no native “Choose File”.
 * The input stays in the page, hidden, under its label, so assistive tools
 * and tests reach it as the field it is.
 */
export function FilePicker({
  label,
  id,
  accept,
  file,
  onChange,
  isDisabled = false,
  buttonLabel = "选择文件",
}: {
  label: string;
  id?: string;
  accept?: string;
  file: File | null;
  onChange: (file: File | null) => void;
  isDisabled?: boolean;
  buttonLabel?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className="ui-file-picker">
      <input
        ref={input}
        {...(id ? { id } : {})}
        className="ui-visually-hidden"
        type="file"
        aria-label={label}
        tabIndex={-1}
        {...(accept ? { accept } : {})}
        disabled={isDisabled}
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
      />
      <Button
        className="ui-button"
        data-variant="secondary"
        data-size="normal"
        isDisabled={isDisabled}
        onPress={() => input.current?.click()}
      >
        <span className="ui-button-label">{buttonLabel}</span>
      </Button>
      <span className="ui-file-picker-name">
        {file ? file.name : "未选择文件"}
      </span>
    </span>
  );
}
