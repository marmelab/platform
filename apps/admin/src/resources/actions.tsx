// Buttons for the admin actions: optional confirmation, pessimistic (the API applies the guards and audits),
// error message from the API in a notification, then a refresh.
import { type ReactNode, useState } from "react";
import { useNotify, useRefresh } from "ra-core";
import { Confirm } from "@/components/admin/confirm";
import { Button } from "@/components/ui/button";

export function ActionButton({
  label,
  action,
  confirm,
  successMessage,
  variant = "outline",
  size = "sm",
  icon,
  disabled,
}: {
  label: string;
  action: () => Promise<unknown>;
  confirm?: { title: string; content: ReactNode };
  successMessage?: string;
  variant?: "default" | "outline" | "destructive" | "secondary" | "ghost";
  size?: "default" | "sm";
  icon?: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const notify = useNotify();
  const refresh = useRefresh();
  const run = async () => {
    setLoading(true);
    try {
      await action();
      if (successMessage) notify(successMessage, { type: "success" });
      refresh();
    } catch (error) {
      notify((error as Error).message || "Action failed", { type: "error" });
    } finally {
      setLoading(false);
      setOpen(false);
    }
  };
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={disabled || loading}
        onClick={(e) => {
          e.stopPropagation();
          if (confirm) setOpen(true);
          else void run();
        }}
      >
        {icon}
        {label}
      </Button>
      {confirm && (
        <Confirm
          isOpen={open}
          loading={loading}
          title={confirm.title}
          content={confirm.content}
          onConfirm={() => void run()}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
