import { Link } from "react-router-dom";
import { Button, Card, CardContent } from "../ui";

interface SignUpFormWrapperProps {
  children: React.ReactNode;
  onSubmit: (e: React.FormEvent) => void;
  isSubmitting: boolean;
  submitDisabled?: boolean;
}

export default function SignUpFormWrapper({
  children,
  onSubmit,
  isSubmitting,
  submitDisabled = false,
}: SignUpFormWrapperProps) {
  return (
    <Card>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-6">
          {children}

          {/* Submit Button */}
          <Button
            type="submit"
            variant="primary"
            disabled={isSubmitting || submitDisabled}
            loading={isSubmitting}
            className="w-full"
          >
            {isSubmitting ? "Creating Account..." : "Sign Up"}
          </Button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-sm text-gray-600">
            Already have an account?{" "}
            <Link
              to="/login"
              className="text-blue-600 hover:text-blue-800 font-medium"
            >
              Log in
            </Link>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
