import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Checkbox as AriaCheckbox,
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
export interface FieldProps {
  label: string;
  description?: string;
  errorMessage?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  children?: ReactNode;
}
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
      className="ui-field"
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
      className="ui-field"
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
      className="ui-field"
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
  ...field
}: FieldProps & {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
}) {
  return (
    <AriaSelect
      className="ui-field"
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key));
      }}
      placeholder={placeholder}
      isDisabled={field.isDisabled ?? false}
      isRequired={field.isRequired ?? false}
      isInvalid={!!field.errorMessage}
    >
      <Field {...field}>
        <Button className="ui-select">
          <SelectValue />
          <Icon name="chevron" />
        </Button>
        <Popover className="ui-popover" placement="bottom start">
          <ListBox
            className="ui-listbox"
            items={options}
            disabledKeys={options
              .filter((option) => option.disabled)
              .map((option) => option.value)}
          >
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
export function NumberField({
  value,
  onChange,
  minValue,
  maxValue,
  step,
  placeholder,
  formatOptions,
  ...field
}: FieldProps & {
  value: number;
  onChange: (value: number) => void;
  minValue?: number;
  maxValue?: number;
  step?: number;
  placeholder?: string;
  formatOptions?: Intl.NumberFormatOptions;
}) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <AriaNumberField
      className="ui-field"
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
          <Button slot="decrement" className="ui-number-step" aria-label="减少">
            <Icon name="minus" />
          </Button>
          <Input
            className="ui-number-input"
            {...(placeholder ? { placeholder } : {})}
            onFocus={() => {
              setDraft(value);
              setFocused(true);
            }}
            onBlur={() => setFocused(false)}
          />
          <Button slot="increment" className="ui-number-step" aria-label="增加">
            <Icon name="plus" />
          </Button>
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
