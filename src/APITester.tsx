import { type FormEvent, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { orpc } from "./orpc-client";

type ProcedureName = "hello.get" | "hello.put" | "hello.helloName";

export function APITester() {
  const responseInputRef = useRef<HTMLTextAreaElement>(null);

  const testEndpoint = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const formData = new FormData(e.currentTarget);
      const procedure = formData.get("procedure") as ProcedureName;
      const name = (formData.get("name") as string) || "";

      let result: unknown;
      if (procedure === "hello.get") {
        result = await orpc.hello.get({});
      } else if (procedure === "hello.put") {
        result = await orpc.hello.put({});
      } else {
        result = await orpc.hello.helloName({ name });
      }

      responseInputRef.current!.value = JSON.stringify(result, null, 2);
    } catch (error) {
      responseInputRef.current!.value = String(error);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={testEndpoint}
        className="flex items-center gap-2 flex-wrap"
      >
        <Label htmlFor="procedure" className="sr-only">
          Procedure
        </Label>
        <Select name="procedure" defaultValue="hello.get">
          <SelectTrigger className="w-[180px]" id="procedure">
            <SelectValue placeholder="Procedure" />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value="hello.get">hello.get</SelectItem>
            <SelectItem value="hello.put">hello.put</SelectItem>
            <SelectItem value="hello.helloName">hello.helloName</SelectItem>
          </SelectContent>
        </Select>
        <Label htmlFor="name" className="sr-only">
          Name
        </Label>
        <Input
          id="name"
          type="text"
          name="name"
          placeholder="name (helloName用)"
        />
        <Button type="submit" variant="secondary">
          Send
        </Button>
      </form>
      <Label htmlFor="response" className="sr-only">
        Response
      </Label>
      <Textarea
        ref={responseInputRef}
        id="response"
        readOnly
        placeholder="Response will appear here..."
        className="min-h-[140px] font-mono resize-y"
      />
    </div>
  );
}
