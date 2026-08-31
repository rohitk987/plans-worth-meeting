import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      style={
        {
          "--normal-bg": "#1b1f23",
          "--normal-text": "#f7f3ec",
          "--normal-border": "rgba(247, 243, 236, 0.22)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
