import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface CopyFieldProps {
  id: string;
  value: string;
  /** Accessible name when no visible <Label> points at the field. */
  label?: string;
  /** Hides the value until the user asks to see it, for anything that must not show up on stream. */
  concealed?: boolean;
}

export function CopyField({ id, value, label, concealed = false }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);
  const [visible, setVisible] = useState(!concealed);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    toast.success("Copiado para a área de transferência");
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex">
      <Input
        id={id}
        aria-label={label}
        readOnly
        value={visible ? value : "•".repeat(Math.min(48, value.length))}
        className="rounded-r-none font-mono text-xs"
        onFocus={(event) => visible && event.currentTarget.select()}
      />
      {concealed && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="rounded-none border-l-0"
              aria-label={visible ? "Ocultar" : "Mostrar"}
              onClick={() => setVisible((current) => !current)}
            >
              {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{visible ? "Ocultar" : "Mostrar"}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="outline" size="icon" className="rounded-l-none border-l-0" aria-label="Copiar" onClick={copy}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copiar</TooltipContent>
      </Tooltip>
    </div>
  );
}
