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

type ProcedureName = "features.list" | "members.list" | "quarters.list";

export function APITester() {
  const responseInputRef = useRef<HTMLTextAreaElement>(null);

  const testEndpoint = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const formData = new FormData(e.currentTarget);
      const procedure = formData.get("procedure") as ProcedureName;

      let result: unknown;
      if (procedure === "features.list") {
        result = await orpc.features.list({});
      } else if (procedure === "members.list") {
        result = await orpc.members.list({});
      } else {
        result = await orpc.quarters.list({});
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
        <Select name="procedure" defaultValue="features.list">
          <SelectTrigger className="w-[180px]" id="procedure">
            <SelectValue placeholder="Procedure" />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value="features.list">features.list</SelectItem>
            <SelectItem value="members.list">members.list</SelectItem>
            <SelectItem value="quarters.list">quarters.list</SelectItem>
          </SelectContent>
        </Select>
        <Label htmlFor="name" className="sr-only">
          Name
        </Label>
        <Input id="name" type="text" name="name" placeholder="(unused)" />
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
